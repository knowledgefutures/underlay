import { hydrateRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import App from '~/App'
import { SSRDataProvider, getClientSSRData } from '~/lib/ssr-data'
import '~/global.css'

const ssrData = getClientSSRData()

hydrateRoot(
  document.getElementById('root')!,
  <BrowserRouter>
    <SSRDataProvider data={ssrData}>
      <App />
    </SSRDataProvider>
  </BrowserRouter>,
)
