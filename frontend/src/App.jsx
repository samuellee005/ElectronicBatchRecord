import { BrowserRouter, Routes, Route } from 'react-router-dom'
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

function Layout({ children }) {
  return (
    <>
      <Nav />
      <main className="main">{children}</main>
    </>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout><Dashboard /></Layout>} />
        <Route path="/forms" element={<Layout><FormsList /></Layout>} />
        <Route path="/forms/build" element={<Layout><BuildForm /></Layout>} />
        <Route path="/forms/builder" element={<Layout><FormBuilder /></Layout>} />
        <Route path="/forms/entry" element={<Layout><DataEntry /></Layout>} />
        <Route path="/batch" element={<Layout><BatchRecord /></Layout>} />
        <Route path="/templates" element={<Layout><Templates /></Layout>} />
        <Route path="/templates/upload" element={<Layout><UploadTemplate /></Layout>} />
        <Route path="/templates/view" element={<Layout><ViewTemplate /></Layout>} />
      </Routes>
    </BrowserRouter>
  )
}
