import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { UserPrefsProvider } from './context/UserPrefsContext'
import Nav from './components/Nav'
import Dashboard from './pages/Dashboard'
import FormsList from './pages/FormsList'
import BatchRecord from './pages/BatchRecord'
import BuildForm from './pages/BuildForm'
import FormBuilder from './pages/FormBuilder'
import DataEntry from './pages/DataEntry'
import Templates from './pages/Templates'
import UploadTemplate from './pages/UploadTemplate'
import ViewTemplate from './pages/ViewTemplate'
import DataSearch from './pages/DataSearch'
import ActiveUsers from './pages/ActiveUsers'

function Layout({ children }) {
  const { pathname } = useLocation()
  const wideMain =
    pathname.startsWith('/forms/builder') || pathname.startsWith('/forms/entry')
  return (
    <div className="app-shell">
      <Nav />
      <main className={wideMain ? 'main main--wide' : 'main'}>{children}</main>
    </div>
  )
}

export default function App() {
  return (
    <UserPrefsProvider>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout><Dashboard /></Layout>} />
        <Route path="/forms" element={<Layout><FormsList /></Layout>} />
        <Route path="/data-search" element={<Layout><DataSearch /></Layout>} />
        <Route path="/active-users" element={<Layout><ActiveUsers /></Layout>} />
        <Route path="/forms/build" element={<Layout><BuildForm /></Layout>} />
        <Route path="/forms/builder" element={<Layout><FormBuilder /></Layout>} />
        <Route path="/forms/entry" element={<Layout><DataEntry /></Layout>} />
        <Route path="/batch" element={<Layout><BatchRecord /></Layout>} />
        <Route path="/templates" element={<Layout><Templates /></Layout>} />
        <Route path="/templates/upload" element={<Layout><UploadTemplate /></Layout>} />
        <Route path="/templates/view" element={<Layout><ViewTemplate /></Layout>} />
      </Routes>
    </BrowserRouter>
    </UserPrefsProvider>
  )
}
