import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { listPdfs, listForms, mergePdfs } from '../api/client'
import './BuildForm.css'

export default function BuildForm() {
  const navigate = useNavigate()
  const [pdfs, setPdfs] = useState([])
  const [forms, setForms] = useState([])
  const [selectedPdfs, setSelectedPdfs] = useState([])
  const [selectedFormId, setSelectedFormId] = useState('')
  const [formName, setFormName] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    Promise.all([listPdfs(), listForms()]).then(([pRes, fRes]) => {
      setPdfs(pRes.pdfs || [])
      setForms(fRes.forms || [])
    }).finally(() => setLoading(false))
  }, [])

  const togglePdf = (name) => {
    setSelectedPdfs((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      let pdfFile
      if (selectedPdfs.length === 0) {
        setError('Select at least one template.')
        setSubmitting(false)
        return
      }
      if (selectedPdfs.length === 1) {
        pdfFile = selectedPdfs[0]
      } else {
        const res = await mergePdfs(selectedPdfs)
        if (!res.filename) throw new Error(res.message || 'Merge failed')
        pdfFile = res.filename
      }
      const params = new URLSearchParams({ file: pdfFile })
      if (selectedFormId) params.set('formId', selectedFormId)
      if (formName.trim()) params.set('name', formName.trim())
      navigate('/forms/builder?' + params.toString())
    } catch (err) {
      setError(err.message || 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="page-content"><h1 className="page-title">Build Form</h1><p>Loading...</p></div>

  return (
    <div className="page-content build-form-page">
      <h1 className="page-title">Build Form</h1>
      <p className="page-subtitle">Choose template(s), then open the form builder.</p>
      {error && <div className="error-message">{error}</div>}
      <form onSubmit={handleSubmit}>
        <div className="form-section">
          <h2>1. Select template(s)</h2>
          {pdfs.length === 0 && <p>No PDFs. <Link to="/templates/upload">Upload one</Link>.</p>}
          <ul className="pdf-list">
            {pdfs.map((p) => (
              <li key={p.name}>
                <label>
                  <input type="checkbox" checked={selectedPdfs.includes(p.name)} onChange={() => togglePdf(p.name)} />
                  {p.display_name || p.name}
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="form-section">
          <h2>2. Form name (optional)</h2>
          <input type="text" className="form-input" placeholder="New form name" value={formName} onChange={(e) => setFormName(e.target.value)} />
        </div>
        <div className="form-section">
          <h2>3. Continue editing (optional)</h2>
          <select className="form-select" value={selectedFormId} onChange={(e) => setSelectedFormId(e.target.value)}>
            <option value="">New form</option>
            {forms.filter((f) => f.isLatest).map((f) => (
              <option key={f.id} value={f.id}>{f.name} (v{f.version ?? 1})</option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn-primary" disabled={submitting || selectedPdfs.length === 0}>{submitting ? 'Opening...' : 'Open Form Builder'}</button>
      </form>
    </div>
  )
}
