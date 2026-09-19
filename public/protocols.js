export const PROTOCOLS = Object.freeze(['openai', 'anthropic', 'responses']);

export const PROTOCOL_LABELS = Object.freeze({
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  responses: 'Responses',
});

export const PROTOCOL_OPTION_LABELS = Object.freeze({
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic 兼容',
  responses: 'Responses 兼容',
});

export const PROTOCOL_HINT = 'OpenAI 兼容走 /chat/completions；Anthropic 兼容走 /messages；Responses 兼容走 /responses。';

export function isValidProtocol(value) {
  return PROTOCOLS.includes(value);
}

export function defaultProtocolForGroup(group) {
  if (group === 'claude') return 'anthropic';
  if (group === 'codex') return 'responses';
  return 'openai';
}

export function protocolBadge(protocol) {
  return PROTOCOL_LABELS[protocol] || PROTOCOL_LABELS.openai;
}

export function protocolSelectOptions() {
  return PROTOCOLS.map(value => ({ value, label: PROTOCOL_OPTION_LABELS[value] }));
}
