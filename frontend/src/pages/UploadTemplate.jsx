import { useState } from 'react'
import { Link } from 'react-router-dom'
import { uploadTemplate } from '../api/client'
import './UploadTemplate.css'

export default function UploadTemplate() {
  const [file, setFile] = useState(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!file) return
    setLoading(true)
    setError(null)
    setMessage(null)
    try {
      await uploadTemplate(file)
      setMessage('PDF uploaded successfully.')
      setFile(null)
      e.target.reset()
    } catch (err) {
      setError(err.message || 'Upload failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page-content upload-page">
      <h1 className="page-title">Upload new template</h1>
      {message && <div className="message success">{message}</div>}
      {error && <div className="message error">{error}</div>}
      <form className="upload-form" onSubmit={handleSubmit}>
        <div className="file-input-wrapper">
          <input id="pdf_file" type="file" accept=".pdf" required onChange={(e) => setFile(e.target.files?.[0] || null)} className="file-input" />
          <label htmlFor="pdf_file" className="file-input-label">Choose PDF File</label>
        </div>
        {file && <div className="file-name">Selected: {file.name}</div>}
        <button type="submit" className="upload-btn" disabled={!file || loading}>{loading ? 'Uploading...' : 'Upload PDF'}</button>
      </form>
      <Link to="/templates" className="back-link">View all templates</Link>
    </div>
  )
}
