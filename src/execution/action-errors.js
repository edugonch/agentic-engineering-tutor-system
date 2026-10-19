export function actionError(code, operation, field, expected_format, next_safe_action, message) {
  const error = new Error(message)
  error.name = "HarnessActionError"
  error.code = code
  error.operation = operation
  error.field = field
  error.expected_format = expected_format
  error.source = "controller_preflight"
  error.next_safe_action = next_safe_action
  return error
}
