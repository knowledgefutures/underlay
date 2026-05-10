import { createContext, useContext } from 'react'

type SSRData = Record<string, unknown>

const SSRDataContext = createContext<SSRData>({})

export function SSRDataProvider({
  data,
  children,
}: {
  data: SSRData
  children: React.ReactNode
}) {
  return <SSRDataContext.Provider value={data}>{children}</SSRDataContext.Provider>
}

export function useSSRData<T>(key: string): T {
  const data = useContext(SSRDataContext)
  return data[key] as T
}

export function getClientSSRData(): SSRData {
  if (typeof window !== 'undefined' && (window as any).__SSR_DATA__) {
    return (window as any).__SSR_DATA__ as SSRData
  }
  return {}
}
