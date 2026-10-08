import type { Diagnostic, DiagnosticCode } from '../contracts';

export class CoreError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(code: DiagnosticCode, message: string, path: string | null = null, field: string | null = null) {
    super(message);
    this.name = 'CoreError';
    this.diagnostics = [{ code, severity: 'error', path, object_id: null, field, message, suggested_action: code === 'CONFLICT' ? 'Reload current state before retrying.' : 'Correct the reported input or inspect recovery state before retrying.' }];
  }
}
export function reject(code: DiagnosticCode, message: string, path: string | null = null, field: string | null = null): never {
  throw new CoreError(code, message, path, field);
}
