import { useState, useEffect } from "react"
import { Link } from "react-router-dom"
import { DocumentTextIcon, PlusCircleIcon } from '@heroicons/react/24/outline'
import { listPdfs } from "../api/client"
import "./Templates.css"

export default function Templates() {
  const [pdfs, setPdfs] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")

  useEffect(() => {
    listPdfs().then((r) => setPdfs(r.pdfs || [])).finally(() => setLoading(false))
  }, [])

  const q = search.trim().toLowerCase()
  const filtered = q ? pdfs.filter((p) => (p.name || "").toLowerCase().includes(q)) : pdfs

  function fmt(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(2) + " MB"
    if (bytes >= 1024) return (bytes / 1024).toFixed(2) + " KB"
    return bytes + " B"
  }

  if (loading) return <div className="page-content"><h1 className="page-title">Templates</h1><p>Loading...</p></div>

  return (
    <div className="page-content">
      <h1 className="page-title">Templates</h1>
      <h2 className="section-title">Uploaded</h2>
      {pdfs.length === 0 && <div className="empty-state"><p>No templates. <Link to="/templates/upload">Upload</Link></p></div>}
      {pdfs.length > 0 && (
        <>
          <input type="text" className="search-box" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="templates-table-wrapper">
            <table className="templates-table">
              <thead><tr><th>Actions</th><th>Name</th><th>Size</th></tr></thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.name}>
                    <td className="actions-cell">
                      <Link to={"/templates/view?file=" + encodeURIComponent(p.name)} className="action-icon view-icon" title="View">
                        <DocumentTextIcon className="action-svg" />
                      </Link>
                      <Link to={"/forms/builder?file=" + encodeURIComponent(p.name)} className="action-icon build-icon" title="Create">
                        <PlusCircleIcon className="action-svg" />
                      </Link>
                    </td>
                    <td>{p.display_name || p.name}</td>
                    <td>{fmt(p.size || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
