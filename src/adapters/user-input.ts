import type { HostId } from '../contracts';
import { isObject } from '../core/documents';
import type { HookInput } from './normalize';

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const fields = (value: unknown, allowed: string[]): value is Record<string, unknown> => isObject(value) && Object.keys(value).every(key => allowed.includes(key));
function options(value: unknown, maximum: number, preview: boolean): boolean {
  return Array.isArray(value) && value.length >= 2 && value.length <= maximum && value.every(option =>
    fields(option, preview ? ['label', 'description', 'preview'] : ['label', 'description']) && text(option.label) && text(option.description) &&
    (option.preview === undefined || preview && typeof option.preview === 'string'));
}

// These native tools only collect human input. This is a shape classifier, not a
// tool implementation, mode override, answer parser or implementation approval.
// Names are exact and host-specific; unknown fields/wrappers keep the normal gate.
export function isUserInputTool(host: HostId, input: HookInput): boolean {
  if (input.hook_event_name !== 'PreToolUse' || !fields(input.tool_input, ['questions'])) return false;
  const questions = input.tool_input.questions;
  if (!Array.isArray(questions) || questions.length === 0) return false;
  if (host === 'codex' && input.tool_name === 'request_user_input_async') {
    return questions.every(question => fields(question, ['title', 'options']) && text(question.title) &&
      (question.options === undefined || Array.isArray(question.options) && question.options.length > 0 && question.options.every(text)));
  }
  if (host === 'codex' && input.tool_name === 'request_user_input') {
    return questions.length <= 3 && questions.every(question => fields(question, ['id', 'header', 'question', 'options']) &&
      text(question.id) && text(question.header) && text(question.question) && options(question.options, 3, false)) &&
      new Set(questions.map(question => question.id)).size === questions.length;
  }
  if (host === 'claude' && input.tool_name === 'AskUserQuestion') {
    return questions.length <= 4 && questions.every(question => fields(question, ['header', 'question', 'options', 'multiSelect']) &&
      text(question.header) && text(question.question) && typeof question.multiSelect === 'boolean' && options(question.options, 4, true));
  }
  return false;
}
