import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'

type SSRData = Record<string, unknown>

const SSRDataContext = createContext<SSRData>({})
const SSRNavigatingContext = createContext<boolean>(false)

export function SSRDataProvider({ data, children }: { data: SSRData; children: React.ReactNode }) {
  const location = useLocation()
  const [currentData, setCurrentData] = useState(data)
  const [dataPath, setDataPath] = useState(location.pathname)
  const isInitial = useRef(true)
  const abortRef = useRef<AbortController | null>(null)

  // Computed synchronously during render — true when the route changed but data hasn't arrived
  const navigating = !isInitial.current && location.pathname !== dataPath

  useEffect(() => {
    if (isInitial.current) {
      isInitial.current = false
      return
    }
    if (location.pathname === dataPath) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    fetch(`/__data?path=${encodeURIComponent(location.pathname)}`, {
      credentials: 'include',
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((result) => {
        if (controller.signal.aborted) return
        if (result.redirect) {
          window.location.href = result.redirect
          return
        }
        setCurrentData(result.data)
        setDataPath(location.pathname)
        if (result.title) document.title = result.title
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.error('Failed to load route data:', err)
        setDataPath(location.pathname)
      })

    return () => controller.abort()
  }, [location.pathname, dataPath])

  return (
    <SSRDataContext.Provider value={currentData}>
      <SSRNavigatingContext.Provider value={navigating}>{children}</SSRNavigatingContext.Provider>
    </SSRDataContext.Provider>
  )
}

export function useSSRData<T>(key: string): T {
  return useContext(SSRDataContext)[key] as T
}

export function useSSRNavigating(): boolean {
  return useContext(SSRNavigatingContext)
}

export function getClientSSRData(): SSRData {
  if (typeof window !== 'undefined' && (window as any).__SSR_DATA__) {
    return (window as any).__SSR_DATA__ as SSRData
  }
  return {}
}
