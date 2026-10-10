import { z, type ZodError, type ZodErrorMap } from "zod";

/** Mensagens em português para os erros genéricos do zod. */
const ptErrorMap: ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case "invalid_type":
      if (issue.received === "undefined") return { message: "campo obrigatório" };
      return { message: `esperado ${issue.expected}, recebido ${issue.received}` };
    case "too_small":
      if (issue.type === "string") return { message: `precisa ter no mínimo ${issue.minimum} caractere(s)` };
      if (issue.type === "array") return { message: `precisa ter no mínimo ${issue.minimum} item(ns)` };
      return { message: `precisa ser maior ou igual a ${issue.minimum}` };
    case "too_big":
      if (issue.type === "string") return { message: `precisa ter no máximo ${issue.maximum} caracteres` };
      if (issue.type === "array") return { message: `precisa ter no máximo ${issue.maximum} itens` };
      return { message: `precisa ser menor ou igual a ${issue.maximum}` };
    case "invalid_string":
      if (issue.validation === "datetime") return { message: "precisa ser data ISO 8601 com fuso (Z ou ±hh:mm)" };
      return { message: "formato inválido" };
    case "not_finite":
      return { message: "precisa ser um número finito" };
    default:
      return { message: ctx.defaultError };
  }
};
z.setErrorMap(ptErrorMap);

export interface FieldIssue {
  path: string;
  message: string;
}

export function issuesOf(error: ZodError): FieldIssue[] {
  return error.issues.map((i) => ({ path: i.path.join(".") || "(corpo)", message: i.message }));
}

/** Resumo de uma linha para o campo `message`; a lista completa vai em `details`. */
export function summarize(error: ZodError): string {
  const [first, ...rest] = issuesOf(error);
  const extra = rest.length > 0 ? ` (e mais ${rest.length} problema(s))` : "";
  return `${first.path}: ${first.message}${extra}`;
}

export { z };
