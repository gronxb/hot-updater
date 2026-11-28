// agent-device bounds its simctl calls, and CoreSimulator can miss those bounds
// on a busy host. The first is the boot check before openurl, so the link was
// never sent. The second is openurl itself, so the Simulator may have received it.
const IOS_LINK_NOT_SENT = /xcrun timed out after \d+ms/;
const IOS_LINK_MAYBE_SENT = /xcrun simctl openurl did not answer within \d+ms/;

export function isIosLinkNotSent(message: string): boolean {
  return IOS_LINK_NOT_SENT.test(message);
}

export function isIosLinkMaybeSent(message: string): boolean {
  return IOS_LINK_MAYBE_SENT.test(message);
}
