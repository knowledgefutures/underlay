import {
  useMutation,
  useQuery,
  type UseMutationOptions,
  type UseQueryOptions,
} from '@tanstack/react-query'

type AnyRpcResponse = { ok: boolean; status: number; json(): Promise<unknown> }
type OkJson<R> = R extends { ok: true; json(): Promise<infer T> } ? T : never

export async function unwrap<R extends AnyRpcResponse>(promise: Promise<R>): Promise<OkJson<R>> {
  const res = await promise
  if (!res.ok) throw new Error(`request failed: ${res.status}`)
  return (await res.json()) as OkJson<R>
}

export function useRpcQuery<R extends AnyRpcResponse, TData = OkJson<R>, TError = Error>(
  options: Omit<UseQueryOptions<OkJson<R>, TError, TData>, 'queryFn'> & {
    queryFn: () => Promise<R>
  },
) {
  const { queryFn, ...rest } = options
  return useQuery<OkJson<R>, TError, TData>({ ...rest, queryFn: () => unwrap(queryFn()) })
}

export function useRpcMutation<TVars, R extends AnyRpcResponse, TError = Error>(
  options: Omit<UseMutationOptions<OkJson<R>, TError, TVars>, 'mutationFn'> & {
    mutationFn: (vars: TVars) => Promise<R>
  },
) {
  const { mutationFn, ...rest } = options
  return useMutation<OkJson<R>, TError, TVars>({
    ...rest,
    mutationFn: (vars) => unwrap(mutationFn(vars)),
  })
}
