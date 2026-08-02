export const CHAT_TURN_STATUS_HEADER = 'X-InkMarshal-Chat-Turn-Status';
export const PERSISTED_CHAT_STOP_MARKER = '<!-- INKMARSHAL_CHAT_STOPPED_V1 -->';

export type ChatTurnRecoveryStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'stale'
  | 'stopped'
  | 'missing';

export function parseChatTurnRecoveryStatus(value: string | null): ChatTurnRecoveryStatus | null {
  switch (value) {
    case 'running':
    case 'succeeded':
    case 'failed':
    case 'cancelled':
    case 'stale':
    case 'stopped':
    case 'missing':
      return value;
    default:
      return null;
  }
}
