export type ChipTone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

export const riskTone = (risk: string): ChipTone => (risk === 'high' ? 'bad' : risk === 'medium' ? 'warn' : 'good');

export const statusTone = (status: string | undefined): ChipTone => {
  switch (status) {
    case 'running':
    case 'claiming':
    case 'planning':
    case 'verifying':
    case 'sent':
      return 'info';
    case 'needs_user':
    case 'pending':
    case 'edited':
      return 'warn';
    case 'done':
    case 'completed':
      return 'good';
    case 'failed':
    case 'killed':
      return 'bad';
    default:
      return 'neutral';
  }
};
