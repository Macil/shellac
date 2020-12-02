import execa, { ExecaSyncReturnValue } from 'execa'
/* NOTE: IMPORTING LIB WHICH IS COMPILED WITH REGHEX */
// @ts-ignore
import _parser from '../lib/parser'

export type ShellacInterpolations =
  | string
  | boolean
  | undefined
  | number
  | null
  | ((a: string) => void)
  | ((a: string) => Promise<void>)
  | (() => Promise<void>)

export type ShellacReturnVal = {
  stdout: string
  stderr: string
  [key: string]: string
}

export type ParseResult = string | (Array<ParseResult> & { tag: string })
type Parser = (str: string) => undefined | ParseResult
export const parser = (str: string) => (_parser as Parser)(str.trim())

export const log_parse_result = (
  chunk: ParseResult,
  depth = 0,
  solo = false
): string => {
  if (!chunk) return ''

  if (Array.isArray(chunk) && chunk.tag) {
    const indent = `${' '.repeat(depth)}`
    const newline = `${depth === 0 ? '' : '\n'}`
    return `${newline}${indent}${chunk.tag + ':'}${chunk
      .map((each) => log_parse_result(each, depth + 2, chunk.length === 1))
      .join('')}`
  } else {
    const indent = solo ? '' : '\n' + ' '.repeat(depth)
    return `${indent} ${(chunk as string).trim()}`
  }
}

type ExecResult = ExecaSyncReturnValue | null
type Captures = { [key: string]: string }

const execute = async (
  interps: ShellacInterpolations[],
  chunk: ParseResult,
  last_cmd: ExecResult,
  cwd: string,
  captures: Captures
): Promise<ExecResult> => {
  // console.log({ chunk })
  if (Array.isArray(chunk)) {
    if (chunk.tag === 'command_line') {
      const [str] = chunk as string[]
      return execa.command(str, { shell: true, cwd })
    } else if (chunk.tag === 'if_statement') {
      const [[val_type, val_id], if_clause, else_clause] = chunk
      // console.log({val_type, val_id, if_clause, else_clause})
      if (val_type !== 'VALUE')
        throw new Error(
          'If statements only accept value interpolations, not functions.'
        )

      // @ts-ignore
      if (interps[val_id]) {
        // console.log("IF STATEMENT IS TRUE")
        return execute(interps, if_clause, last_cmd, cwd, captures)
      } else if (else_clause) {
        // console.log("IF STATEMENT IS FALSE")
        return execute(interps, else_clause, last_cmd, cwd, captures)
      }
    } else if (chunk.tag === 'in_statement') {
      const [[val_type, val_id], in_clause] = chunk
      if (val_type !== 'VALUE')
        throw new Error(
          'IN statements only accept value interpolations, not functions.'
        )

      // @ts-ignore
      const new_cwd = interps[val_id]
      if (!new_cwd || typeof new_cwd !== 'string')
        throw new Error(
          `IN statements need a string value to set as the current working dir`
        )

      return execute(interps, in_clause, last_cmd, new_cwd, captures)
    } else if (chunk.tag === 'grammar') {
      let new_last_cmd = last_cmd
      for (const sub of chunk) {
        new_last_cmd = await execute(interps, sub, new_last_cmd, cwd, captures)
      }
      return new_last_cmd
    } else if (chunk.tag === 'await_statement') {
      const [[val_type, val_id]] = chunk
      if (val_type !== 'FUNCTION')
        throw new Error(
          'IN statements only accept function interpolations, not values.'
        )

      // @ts-ignore
      await interps[val_id]()
    } else if (chunk.tag === 'stdout_statement') {
      const [out_or_err, second] = chunk
      if (!(out_or_err === 'stdout' || out_or_err === 'stderr'))
        throw new Error(
          `Expected only 'stdout' or 'stderr', got: ${out_or_err}`
        )
      const capture = last_cmd?.[out_or_err] || ''
      // @ts-ignore
      const tag: string = second.tag
      if (tag === 'identifier') {
        const [val_type, val_id] = second
        if (val_type !== 'FUNCTION')
          throw new Error(
            'STDOUT/STDERR statements only accept function interpolations, not values.'
          )

        // @ts-ignore
        await interps[val_id](capture)
      } else if (tag === 'variable_name') {
        captures[second[0] as string] = capture
      } else {
        throw new Error(
          'STDOUT/STDERR statements expect a variable name or an interpolation function.'
        )
      }
    }
  }

  return last_cmd
}

type ShellacImpl = (
  s: TemplateStringsArray,
  ...interps: ShellacInterpolations[]
) => Promise<ShellacReturnVal>

const _shellac = (cwd: string): ShellacImpl => async (s, ...interps) => {
  let str = s[0]

  for (let i = 0; i < interps.length; i++) {
    const is_fn = typeof interps[i] === 'function';
    const interp_placeholder = `#__${is_fn ? 'FUNCTION_' : 'VALUE_'}${i}__#`
    str += interp_placeholder + s[i + 1]
  }

  if (str.length === 0) throw new Error('Must provide statements')

  // console.log(str)

  const parsed = parser(str)
  if (!parsed || typeof parsed === 'string') throw new Error('Parsing error!')

  // console.log(parsed)
  const captures: Captures = {}

  const last_cmd = await execute(interps, parsed, null, cwd, captures)

  return {
    stdout: last_cmd?.stdout || '',
    stderr: last_cmd?.stderr || '',
    ...captures,
  }
}

const shellac = Object.assign(_shellac(process.cwd()), {
  in: (cwd: string) => _shellac(cwd),
})

export default shellac
