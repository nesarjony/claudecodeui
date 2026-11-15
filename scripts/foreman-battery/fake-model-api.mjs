// A scripted stand-in for the model endpoint (claude-cap's worker profile). The REAL Claude Code CLI, started by the REAL cloudcli
// session path, talks to it, so the tool calls it receives are executed by the real CLI under the session's real sandbox and
// permission rules, with no model and no cost. It answers as `model` (what the profile's upstream reports).
// `steps` is a list of tool calls ({ tool, input }). The server emits them one per assistant turn and records what the CLI
// answered for each (the tool result, and whether it was an error). Anything else the CLI asks for (titles, token counts, model
// discovery) gets a harmless answer.
// `marker` keeps the steps to one session: the instance is shared, and a conversation that does not carry the marker (another session sent here
// while a script has the instance) gets an error instead of the scripted calls. `onStep(index)` is awaited before step `index` is issued (and with
// `steps.length` before the final answer), that is after the previous step's result came back: a script reads the host there to judge each step
// by its own effect.
import http from 'node:http'

/** @typedef {{ tool: string, input: Record<string, unknown> }} Step */

const textOf = content => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : '')).join('')
  return ''
}

/**
 * @param {Step[]} steps
 * @param {{ model?: string, port?: number, quota?: { reason: string, resetAt?: string | null, retryAfter?: number, message: string } | null, marker?: string | null, onStep?: ((index: number) => Promise<void> | void) | null }} [options]
 */
export async function startFakeApi(steps, { model: answeringModel = 'MiniMax-M3', port: wantedPort = 0, quota = null, marker = null, onStep = null } = {}) {
  // `quota` makes every request answer like claude-cap does for a profile over its share: 429 `profile_quota` with `retry-after`.
  /** @type {Array<{ i: number, tool: string, input: unknown, isError: boolean, text: string }>} */
  const results = []
  const seen = new Set()
  let mainRequests = 0
  /** The path prefixes the CLI addressed `/v1/messages` through: `/profile/<name>` when it routes by the profile URL. */
  const requestPaths = new Set()
  let otherRequests = 0
  let foreignRequests = 0
  /** The step indexes `onStep` was awaited for: a request the CLI retries does not read the host a second time. */
  const stepped = new Set()

  const sse = (res, events) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    res.end()
  }

  const message = (model, content, stop) => ({
    id: `msg_fake_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  })

  const streamMessage = (res, model, blocks, stop) => {
    const events = [['message_start', { type: 'message_start', message: { ...message(model, [], null), usage: { input_tokens: 10, output_tokens: 1 } } }]]
    blocks.forEach((b, index) => {
      if (b.type === 'tool_use') {
        events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }])
        events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }])
      } else {
        events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }])
        events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }])
      }
      events.push(['content_block_stop', { type: 'content_block_stop', index }])
    })
    events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }])
    events.push(['message_stop', { type: 'message_stop' }])
    sse(res, events)
  }

  const handleMessages = async (body, res) => {
    const model = answeringModel
    const tools = Array.isArray(body.tools) ? body.tools : []
    const isMain = tools.some(t => t && (t.name === 'Bash' || t.name === 'Read'))
    if (!isMain) {
      otherRequests += 1
      const reply = [{ type: 'text', text: 'ok' }]
      if (body.stream) return streamMessage(res, model, [{ type: 'text', text: 'ok' }], 'end_turn')
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(message(model, reply, 'end_turn')))
    }
    const messages = Array.isArray(body.messages) ? body.messages : []
    if (marker && !JSON.stringify(messages).includes(marker)) {
      foreignRequests += 1
      res.writeHead(503, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'This endpoint is a scripted stand-in for the sandbox battery and answers only its own session.' } }))
    }
    mainRequests += 1
    // What the CLI answered for the tool calls this server made so far.
    let issued = 0
    const ids = []
    for (const m of messages) {
      if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_use') { issued += 1; ids.push(b.id) }
      if (m.role === 'user' && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && b.type === 'tool_result' && !seen.has(b.tool_use_id)) {
            const idx = ids.indexOf(b.tool_use_id)
            if (idx >= 0 && idx < steps.length) {
              seen.add(b.tool_use_id)
              results.push({ i: idx, tool: steps[idx].tool, input: steps[idx].input, isError: b.is_error === true, text: textOf(b.content) })
            }
          }
        }
      }
    }
    if (onStep && !stepped.has(issued)) {
      stepped.add(issued)
      await onStep(issued)
    }
    if (issued < steps.length) {
      const step = steps[issued]
      const block = { type: 'tool_use', id: `toolu_fake_${String(issued).padStart(3, '0')}`, name: step.tool, input: step.input }
      return body.stream ? streamMessage(res, model, [block], 'tool_use') : (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(message(model, [block], 'tool_use'))))
    }
    return body.stream ? streamMessage(res, model, [{ type: 'text', text: 'DONE' }], 'end_turn') : (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(message(model, [{ type: 'text', text: 'DONE' }], 'end_turn'))))
  }

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* not JSON */ }
      // The CLI addresses the profile in the path (`/profile/<name>/v1/messages`), as claude-cap expects.
      if (req.method === 'POST' && /\/v1\/messages(\?|$)/.test(req.url ?? '')) requestPaths.add((req.url ?? '').replace(/\/v1\/messages.*$/, ''))
      const url = (req.url ?? '').replace(/^\/profile\/[^/]+/, '')
      if (quota && req.method === 'POST' && /^\/v1\/messages(\?|$)/.test(url)) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(quota.retryAfter ?? 60) })
        return res.end(JSON.stringify({ error: { type: 'profile_quota', reason: quota.reason, message: quota.message, profile: 'foreman-worker', upstream: 'minimax', windows: [], resetAt: quota.resetAt ?? null } }))
      }
      try {
        if (req.method === 'POST' && /^\/v1\/messages(\?|$)/.test(url)) {
          return handleMessages(body, res).catch(error => {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(error) } }))
          })
        }
        otherRequests += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        if (url.includes('/count_tokens')) return res.end(JSON.stringify({ input_tokens: 100 }))
        if (url.includes('/v1/models')) return res.end(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }))
        return res.end('{}')
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(error) } }))
      }
    })
  })
  await new Promise(resolve => server.listen(wantedPort, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    results: () => results.slice().sort((a, b) => a.i - b.i),
    stats: () => ({ mainRequests, otherRequests, foreignRequests }),
    requestPaths: () => [...requestPaths],
    // A held CLI process keeps its connection open; close it too, or the port stays taken for the next session's stand-in.
    close: () => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}
