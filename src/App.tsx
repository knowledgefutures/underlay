import { lazy, Suspense, } from 'react'
import { Route, Routes, } from 'react-router'
import { buildRoutes, } from '~/route-gen'

const modules = import.meta.glob<{ default: React.ComponentType }>('./routes/**/[!_]*.tsx',)
const routes = buildRoutes(modules,)

const componentMap = new Map(
  routes.map((r,) => [
    r.path,
    lazy(modules[r.filePath]!,),
  ]),
)

export { routes, }

export default function App() {
  return (
    <Suspense>
      <Routes>
        {routes.map((r,) => {
          const Page = componentMap.get(r.path,)
          return Page ? <Route key={r.path} path={r.path} element={<Page />} /> : null
        },)}
      </Routes>
    </Suspense>
  )
}
