export class ExternalWaitError extends Error {
  constructor(kind, message) {
    super(message)
    this.name = "ExternalWaitError"
    this.kind = kind
  }
}
