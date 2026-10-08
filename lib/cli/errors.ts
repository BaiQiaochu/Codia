// @ts-nocheck
export class CliError extends Error {
  constructor(message, { code = 1, details = null } = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }
}
