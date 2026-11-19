import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ImagePlus, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export const documents = [
  { key: 'passport-photo', title: 'Passport-size photograph', name: 'passport-size photograph' },
  { key: 'student-card', title: 'Student ID card', name: 'student ID card' },
  { key: 'cnic-front', title: 'Front side', name: 'CNIC front side' },
  { key: 'cnic-back', title: 'Back side', name: 'CNIC back side' },
] as const
export type DocumentKey = typeof documents[number]['key']

function usePreview(file?: File) {
  const [preview, setPreview] = useState('')
  useEffect(() => {
    if (!file) { setPreview(''); return }
    const previewUrl = URL.createObjectURL(file)
    setPreview(previewUrl)
    return () => URL.revokeObjectURL(previewUrl)
  }, [file])
  return preview
}

export function UploadControl({ document, file, error, onChange }: {
  document: typeof documents[number]
  file?: File
  error?: string
  onChange: (file?: File) => void
}) {
  const { key, title, name } = document
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const picker = useRef<HTMLButtonElement>(null)
  const preview = usePreview(file)
  const reduced = useReducedMotion()
  const description = error ? `upload-guidance ${key}-error` : 'upload-guidance'
  const choose = () => input.current?.click()

  return <div className="upload-field">
    <label htmlFor={`${key}-file`} className="upload-label">{title} <span className="required" aria-hidden="true">*</span></label>
    <div className={`dropzone ${dragging ? 'dragging' : ''} ${error ? 'invalid' : ''} ${file ? '' : 'empty'}`}
      onDragEnter={event => { event.preventDefault(); if (!input.current?.matches(':disabled')) setDragging(true) }}
      onDragOver={event => event.preventDefault()}
      onDragLeave={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false)
      }}
      onDrop={event => {
        event.preventDefault()
        setDragging(false)
        const dropped = event.dataTransfer.files[0]
        if (dropped && !input.current?.matches(':disabled')) onChange(dropped)
      }}>
      <input className="visually-hidden" id={`${key}-file`} type="file" accept="image/jpeg,image/png" ref={input}
        tabIndex={-1} aria-required="true" aria-invalid={!!error} aria-describedby={description}
        onChange={event => { const chosen = event.target.files?.[0]; if (chosen) onChange(chosen); event.target.value = '' }} />
      <AnimatePresence initial={false} mode="wait">
        {file && preview ? <motion.span className="upload-icon" key={preview}
          initial={reduced ? false : { opacity: .55 }} animate={{ opacity: 1 }} transition={{ duration: .16 }}>
          <img src={preview} alt={`Preview of ${name}`} />
        </motion.span> : <span className="upload-icon" key="empty"><ImagePlus size={22} aria-hidden="true" /></span>}
      </AnimatePresence>
      <div className="file-info">
        {file
          ? <><strong title={file.name}>{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(2)} MB</span></>
          : <><span className="drop-label">Choose an image</span><span>or drag one here</span></>}
      </div>
      <button id={key} className="small-button upload-picker" ref={picker} type="button"
        aria-label={`${file ? 'Replace' : 'Choose'} ${name}`} aria-describedby={description} aria-invalid={!!error}
        onClick={choose}>{file ? 'Replace' : <Upload size={16} aria-hidden="true" />}</button>
      {file && <button className="small-button remove" type="button" aria-label={`Remove ${name}`}
        onClick={() => { onChange(); picker.current?.focus() }}><X size={18} aria-hidden="true" /></button>}
    </div>
    {error && <p className="field-error" id={`${key}-error`}>{error}</p>}
  </div>
}
