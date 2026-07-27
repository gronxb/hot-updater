export class EvidenceInvariantError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "EvidenceInvariantError";
    this.code = code;
  }
}

export const evidenceInvariant = (condition, code, message) => {
  if (!condition) {
    throw new EvidenceInvariantError(code, message);
  }
};
