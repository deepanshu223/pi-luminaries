export function event(state, eventId) {
  const record = state.mailbox[eventId];
  return record?.lane === 'direct' ? undefined : record;
}

export function events(state) {
  return Object.values(state.mailbox).filter((record) => record.lane !== 'direct');
}

export function control(state, controlId) {
  const record = state.mailbox[controlId];
  return record?.lane === 'direct' ? record : undefined;
}

export function controls(state) {
  return Object.values(state.mailbox).filter((record) => record.lane === 'direct');
}
