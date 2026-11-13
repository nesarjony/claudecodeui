/**
 * Readers for the little programs that sit inside a shell command: an `awk` program, a `sed` script, the code of `node -e` or `python -c`.
 *
 * The structural reader of `shell.ts` and the secret reader of `secrets.ts` both treat the words of a command as paths. The text of a
 * program is not a path: it is full of `.*`, `.key`, `|` and `>`, and read as a path it is held for the wrong reasons. These readers
 * answer the questions that matter for a program instead: does it run a command, write a file, read a named file, read the environment?
 * They read the text (strings and regular expressions are skipped as such); they are a heuristic, never a sandbox, and they err towards "yes, it does".
 *
 * Pure: no file system, no process.
 */

// ------------------------------------------------------------------------------------------------ awk

type AwkToken = { t: 'str' | 're' | 'id' | 'num' | 'op'; v: string };

const AWK_REGEX_AFTER = new Set(['print', 'printf', 'return', 'in', 'getline', 'delete', 'if', 'while', 'for', 'do', 'else', 'exit', 'next', 'nextfile', 'function', 'func']);
const AWK_TWO_CHAR = new Set(['>>', '>=', '<=', '==', '!=', '!~', '&&', '||', '|&', '++', '--', '**', '+=', '-=', '*=', '/=', '%=', '^=']);

/** An awk program as tokens: strings and regular expression literals are single tokens, so a `|` or `>` inside one is not an operator. */
function awkTokens(program: string): AwkToken[] {
  const tokens: AwkToken[] = [];
  let i = 0;
  const n = program.length;
  const regexAllowed = (): boolean => {
    const last = tokens[tokens.length - 1];
    if (!last) {
      return true;
    }
    if (last.t === 'op') {
      return last.v !== ')' && last.v !== ']';
    }
    return last.t === 'id' && AWK_REGEX_AFTER.has(last.v);
  };
  while (i < n) {
    const c = program[i]!;
    if (c === ' ' || c === '\t' || c === '\r') {
      i += 1;
    } else if (c === '\n') {
      tokens.push({ t: 'op', v: ';' });
      i += 1;
    } else if (c === '#') {
      while (i < n && program[i] !== '\n') {
        i += 1;
      }
    } else if (c === '"') {
      let value = '';
      i += 1;
      while (i < n && program[i] !== '"') {
        if (program[i] === '\\' && i + 1 < n) {
          value += program[i + 1] === '"' || program[i + 1] === '\\' || program[i + 1] === '/' ? program[i + 1] : `\\${program[i + 1]}`;
          i += 2;
        } else {
          value += program[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ t: 'str', v: value });
    } else if (c === '/' && regexAllowed()) {
      let inClass = false;
      i += 1;
      const start = i;
      while (i < n && (inClass || program[i] !== '/')) {
        if (program[i] === '\\') {
          i += 1;
        } else if (program[i] === '[') {
          inClass = true;
        } else if (program[i] === ']') {
          inClass = false;
        }
        i += 1;
      }
      tokens.push({ t: 're', v: program.slice(start, i) });
      i += 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_]/.test(program[i]!)) {
        i += 1;
      }
      tokens.push({ t: 'id', v: program.slice(start, i) });
    } else if (/[0-9.]/.test(c) && (c !== '.' || /[0-9]/.test(program[i + 1] ?? ''))) {
      const start = i;
      while (i < n && /[0-9.eE]/.test(program[i]!)) {
        i += 1;
      }
      tokens.push({ t: 'num', v: program.slice(start, i) });
    } else {
      const two = program.slice(i, i + 2);
      if (AWK_TWO_CHAR.has(two)) {
        tokens.push({ t: 'op', v: two });
        i += 2;
      } else {
        tokens.push({ t: 'op', v: c });
        i += 1;
      }
    }
  }
  return tokens;
}

export interface AwkFacts {
  /** `system(...)`: runs a command. */
  system: boolean;
  /** A pipe to or from a command (`print | "sh"`, `"cmd" | getline`). */
  pipe: boolean;
  /** `ENVIRON`: reads the environment. */
  environ: boolean;
  /** `@include`, `@load`: code from another file. */
  include: boolean;
  /** `print > file`, `print >> file`; `target` is the file name when it is a plain string, null when it is built at run time. */
  redirects: Array<{ op: string; target: string | null }>;
  /** `getline < file`; `target` as above. A plain `getline` (from the input) is not listed. */
  reads: Array<string | null>;
}

/** What an awk program does besides print to standard output (see `AwkFacts`). */
// Consumed by the structural reader (`shell.ts`) and by the read-only recogniser (`readonly.ts`).
export function awkFacts(program: string): AwkFacts {
  const facts: AwkFacts = { system: false, pipe: false, environ: false, include: false, redirects: [], reads: [] };
  const tokens = awkTokens(program);
  let inPrint = false;
  let depth = 0;
  for (const [k, token] of tokens.entries()) {
    if (token.t === 'id') {
      if (token.v === 'print' || token.v === 'printf') {
        inPrint = true;
        depth = 0;
      } else if (token.v === 'system') {
        facts.system = true;
      } else if (token.v === 'ENVIRON') {
        facts.environ = true;
      } else if (token.v === 'getline') {
        for (let j = k + 1; j < Math.min(tokens.length, k + 4); j += 1) {
          const next = tokens[j]!;
          if (next.t === 'op' && next.v === '<') {
            const target = tokens[j + 1];
            facts.reads.push(target && target.t === 'str' ? target.v : null);
            break;
          }
          if (next.t === 'op' && next.v !== '$' && next.v !== '[' && next.v !== ']') {
            break;
          }
        }
      } else if ((token.v === 'include' || token.v === 'load') && tokens[k - 1]?.t === 'op' && tokens[k - 1]!.v === '@') {
        facts.include = true;
      }
      continue;
    }
    if (token.t !== 'op') {
      continue;
    }
    if (token.v === '(') {
      depth += 1;
    } else if (token.v === ')') {
      depth = Math.max(0, depth - 1);
    } else if ((token.v === ';' || token.v === '}') && depth === 0) {
      inPrint = false;
    } else if (token.v === '|' || token.v === '|&') {
      facts.pipe = true;
    } else if (inPrint && depth === 0 && (token.v === '>' || token.v === '>>')) {
      const target = tokens[k + 1];
      const after = tokens[k + 2];
      const plain = target?.t === 'str' && (after === undefined || (after.t === 'op' && (after.v === ';' || after.v === '}' || after.v === ')')));
      facts.redirects.push({ op: token.v, target: plain ? target.v : null });
    }
  }
  return facts;
}

// ------------------------------------------------------------------------------------------------ sed

export interface SedFacts {
  /** False when the script has a form this reader does not understand: nothing is claimed about it. */
  parsed: boolean;
  /** File names of `r` and `R` commands. */
  reads: string[];
  /** File names of `w`, `W` commands and the `w` flag of `s`. */
  writes: string[];
  /** An `e` command or the `e` flag of `s`: runs a command. */
  exec: boolean;
}

/** What a sed script does besides edit the stream: reads or writes a named file, runs a command. */
// Consumed by the structural reader (`shell.ts`) and by the read-only recogniser (`readonly.ts`).
export function sedFacts(script: string): SedFacts {
  const facts: SedFacts = { parsed: true, reads: [], writes: [], exec: false };
  const n = script.length;
  let i = 0;
  const fail = (): SedFacts => ({ ...facts, parsed: false });
  const skipBlanks = () => {
    while (i < n && (script[i] === ' ' || script[i] === '\t')) {
      i += 1;
    }
  };
  const readUntil = (delimiter: string): boolean => {
    while (i < n) {
      const c = script[i]!;
      if (c === '\\') {
        i += 2;
      } else if (c === delimiter) {
        i += 1;
        return true;
      } else {
        i += 1;
      }
    }
    return false;
  };
  const restOfLine = (): string => {
    skipBlanks();
    const start = i;
    while (i < n && script[i] !== '\n') {
      i += 1;
    }
    return script.slice(start, i).trim();
  };
  const address = (): boolean => {
    const c = script[i];
    if (c === undefined) {
      return false;
    }
    if (/[0-9]/.test(c)) {
      while (i < n && /[0-9]/.test(script[i]!)) {
        i += 1;
      }
      if (script[i] === '~') {
        i += 1;
        while (i < n && /[0-9]/.test(script[i]!)) {
          i += 1;
        }
      }
      return true;
    }
    if (c === '$') {
      i += 1;
      return true;
    }
    if (c === '/' || c === '\\') {
      i += 1;
      const delimiter = c === '\\' ? script[i++] : '/';
      if (!delimiter || !readUntil(delimiter)) {
        return false;
      }
      while (i < n && /[IM]/.test(script[i]!)) {
        i += 1;
      }
      return true;
    }
    return false;
  };
  while (i < n) {
    skipBlanks();
    const c = script[i];
    if (c === undefined) {
      break;
    }
    if (c === ';' || c === '\n' || c === '{' || c === '}') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < n && script[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (address()) {
      skipBlanks();
      if (script[i] === ',') {
        i += 1;
        skipBlanks();
        if (script[i] === '+' || script[i] === '~') {
          i += 1;
          while (i < n && /[0-9]/.test(script[i]!)) {
            i += 1;
          }
        } else if (!address()) {
          return fail();
        }
      }
    }
    skipBlanks();
    while (script[i] === '!') {
      i += 1;
      skipBlanks();
    }
    const command = script[i];
    i += 1;
    switch (command) {
      case 's': {
        const delimiter = script[i++];
        if (!delimiter || delimiter === '\n' || delimiter === '\\' || !readUntil(delimiter) || !readUntil(delimiter)) {
          return fail();
        }
        while (i < n && /[gpiImMeE0-9]/.test(script[i]!)) {
          if (script[i] === 'e') {
            facts.exec = true;
          }
          i += 1;
        }
        if (script[i] === 'w') {
          i += 1;
          const file = restOfLine();
          if (!file) {
            return fail();
          }
          facts.writes.push(file);
        }
        break;
      }
      case 'y': {
        const delimiter = script[i++];
        if (!delimiter || delimiter === '\n' || delimiter === '\\' || !readUntil(delimiter) || !readUntil(delimiter)) {
          return fail();
        }
        break;
      }
      case 'r':
      case 'R': {
        const file = restOfLine();
        if (!file) {
          return fail();
        }
        facts.reads.push(file);
        break;
      }
      case 'w':
      case 'W': {
        const file = restOfLine();
        if (!file) {
          return fail();
        }
        facts.writes.push(file);
        break;
      }
      case 'e':
        facts.exec = true;
        restOfLine();
        break;
      case 'a':
      case 'i':
      case 'c':
      case 'v':
        restOfLine();
        break;
      case ':':
      case 'b':
      case 't':
      case 'T':
        while (i < n && script[i] !== ';' && script[i] !== '\n' && script[i] !== '}') {
          i += 1;
        }
        break;
      case 'q':
      case 'Q':
      case 'l':
      case 'L':
        while (i < n && /[0-9 \t]/.test(script[i]!)) {
          i += 1;
        }
        break;
      case '{':
      case '}':
      case 'p':
      case 'P':
      case 'd':
      case 'D':
      case 'n':
      case 'N':
      case 'g':
      case 'G':
      case 'h':
      case 'H':
      case 'x':
      case '=':
      case 'z':
      case 'F':
        break;
      default:
        return fail();
    }
  }
  return facts;
}

// ------------------------------------------------------------------------------------------------ inline code

/** The string literals of a piece of code (`'...'`, `"..."`, `` `...` ``), escapes left as written. The names of properties, variables and functions are not among them. */
// Consumed by the structural reader for `node -e`, `python -c` and the like, and by the tests.
export function stringLiterals(code: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i]!;
    if (c === "'" || c === '"' || c === '`') {
      // Python triple quotes are strings too.
      const triple = code.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      i += close.length;
      const start = i;
      while (i < n && !code.startsWith(close, i)) {
        i += code[i] === '\\' ? 2 : 1;
      }
      out.push(code.slice(start, Math.min(i, n)));
      i += close.length;
    } else if (c === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') {
        i += 1;
      }
    } else if (c === '#') {
      while (i < n && code[i] !== '\n') {
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return out;
}
