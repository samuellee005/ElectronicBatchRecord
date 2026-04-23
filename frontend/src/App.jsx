import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { UserPrefsProvider } from './context/UserPrefsContext'
import { AuthProvider } from './context/AuthContext'
import ProtectedLayout from './components/ProtectedLayout'
import Dashboard from './pages/Dashboard'
import FormsList from './pages/FormsList'
import FormAudit from './pages/FormAudit'
import BatchRecord from './pages/BatchRecord'
import BuildForm from './pages/BuildForm'
import FormBuilder from './pages/FormBuilder'
import DataEntry from './pages/DataEntry'
import Templates from './pages/Templates'
import UploadTemplate from './pages/UploadTemplate'
import ViewTemplate from './pages/ViewTemplate'
import DataSearch from './pages/DataSearch'
import ActiveUsers from './pages/ActiveUsers'
import Login from './pages/Login'
import Profile from './pages/Profile'

export default function App() {
  return (
    <UserPrefsProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<ProtectedLayout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/forms" element={<FormsList />} />
              <Route path="/forms/audit" element={<FormAudit />} />
              <Route path="/data-search" element={<DataSearch />} />
              <Route path="/active-users" element={<ActiveUsers />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/forms/build" element={<BuildForm />} />
              <Route path="/forms/builder" element={<FormBuilder />} />
              <Route path="/forms/entry" element={<DataEntry />} />
              <Route path="/batch" element={<BatchRecord />} />
              <Route path="/templates" element={<Templates />} />
              <Route path="/templates/upload" element={<UploadTemplate />} />
              <Route path="/templates/view" element={<ViewTemplate />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </UserPrefsProvider>
  )
}
