import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { MotionConfig, motion, useReducedMotion } from 'motion/react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, Clock3, Download, FileImage, Flame, IdCard, ImagePlus, LockKeyhole, ShieldCheck, Upload, X } from 'lucide-react'
import Turnstile from 'react-turnstile'
import { ApiError, getConfig, getReceipt, submit, type PortalConfig, type Receipt } from './api'

const documents = [
  { key: 'passport-photo', title: 'Passport photograph' },
  { key: 'student-card', title: 'Student ID card' },
  { key: 'cnic-front', title: 'CNIC front' },
  { key: 'cnic-back', title: 'CNIC back' },
] as const

const stages = [
  { label: 'Student Details', title: 'Student details', description: 'Enter your details as they appear in your student records.' },
  { label: 'Documents', title: 'Required documents', description: 'Add a clear image for each item. Make sure all details are readable.' },
  { label: 'Review', title: 'Review and submit', description: 'Check your details and documents before submitting.' },
]
const initialFields = { name: '', roll: '', department: '', semester: '', mobile: '', category: '' }
type Detail = keyof typeof initialFields
type DocKey = typeof documents[number]['key']
type Files = Partial<Record<DocKey, File>>
type Errors = Record<string, string>

function Brand() {
  return <a className="brand" href="#top" aria-label="TAAKRA 2027 home">
    <span className="brand-icon"><Flame size={17} fill="currentColor" strokeWidth={1.5} /></span>
    <span>TAAKRA <em>2027</em></span>
  </a>
}

function Introduction() {
  return <section className="intro" aria-labelledby="intro-title">
    <p className="eyebrow"><span /> STUDENT REGISTRATION</p>
    <h1 id="intro-title">Your TAAKRA journey <em>starts here.</em></h1>
    <p className="intro-copy">Register for TAAKRA 2027 in three steps. Have your passport photograph, student ID card and both sides of your CNIC ready.</p>
    <figure className="artwork">
      <img src="/taakra-art.webp" alt="Two black stone bulls facing each other across a molten orange fissure" width="1152" height="768" />
    </figure>
    <div className="intro-note"><span className="intro-note-icon"><IdCard size={18} /></span><p><strong>Have your documents ready</strong><br />JPEG or PNG · Up to 5 MB each</p></div>
  </section>
}

function Field({ name, label, error, hint, optional, children }: {
  name: string; label: string; error?: string; hint?: string; optional?: boolean; children: ReactNode
}) {
  return <div className="field">
    <label htmlFor={name}>{label} {optional ? <span className="optional">Optional</span> : <span className="required" aria-hidden="true">*</span>}</label>
    {children}
    {hint && <p id={`${name}-hint`} className="field-hint">{hint}</p>}
    {error && <p id={`${name}-error`} className="field-error">{error}</p>}
  </div>
}

function useFilePreview(file?: File) {
  const [preview, setPreview] = useState('')
  useEffect(() => {
    if (!file) { setPreview(''); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  return preview
}

function UploadControl({ kind, title, file, error, change }: {
  kind: DocKey; title: string; file?: File; error?: string; change: (file?: File) => void
}) {
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const picker = useRef<HTMLButtonElement>(null)
  const preview = useFilePreview(file)
  return <div className="upload-field">
    <label htmlFor={kind} className="upload-label">{title} <span className="required" aria-hidden="true">*</span></label>
    <div className={`dropzone ${dragging ? 'dragging' : ''} ${error ? 'invalid' : ''}`}
      onDragOver={event => { event.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => { event.preventDefault(); setDragging(false); change(event.dataTransfer.files[0]) }}>
      <input className="visually-hidden" id={kind} type="file" accept="image/jpeg,image/png" ref={input}
        tabIndex={-1} aria-required="true" aria-invalid={!!error} aria-describedby={error ? `${kind}-error` : 'uploads-hint'}
        onChange={event => { const chosen = event.target.files?.[0]; if (chosen) change(chosen); event.target.value = '' }} />
      <span className="upload-icon">{file && preview ? <img src={preview} alt={`Preview of ${title.toLowerCase()}`} /> : <ImagePlus size={20} />}</span>
      <div className="file-info">
        {file ? <><strong>{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(2)} MB</span></> : <><strong>Choose an image</strong><span>or drag an image here</span></>}
      </div>
      <button className="small-button" ref={picker} type="button" aria-label={`${file ? 'Replace' : 'Choose'} ${title.toLowerCase()}`}
        aria-describedby={error ? `${kind}-error` : 'uploads-hint'} onClick={() => input.current?.click()}>{file ? 'Replace' : <Upload size={17} />}</button>
      {file && <button className="small-button remove" type="button" aria-label={`Remove ${title.toLowerCase()}`} onClick={() => { change(); picker.current?.focus() }}><X size={17} /></button>}
    </div>
    {error && <p id={`${kind}-error`} className="field-error">{error}</p>}
  </div>
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function downloadReceipt(receipt: Receipt) {
  const text = `TAAKRA 2027 — Registration receipt\n\nReference: ${receipt.reference}\nStudent: ${receipt.name}\nSubmitted: ${dateLabel(receipt.submittedAt)}\nSubmitted at (UTC): ${receipt.submittedAt}\nStatus: Submitted for review\n`
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${receipt.reference}-receipt.txt`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function ReceiptView({ receipt, refresh, statusMessage }: { receipt: Receipt; refresh: () => void; statusMessage: string }) {
  const complete = receipt.status === 'complete'
  return <div className="receipt-view">
    <span className={`receipt-icon ${complete ? 'complete' : ''}`}>{complete ? <Check size={27} /> : <Clock3 size={27} />}</span>
    <h2 id="form-title" tabIndex={-1}>{complete ? 'Registration complete' : 'Received — processing'}</h2>
    <p role="status">{complete ? 'Your registration has been submitted for review.' : 'Your submission has been saved. We’re still saving the documents and registration record to organizer storage.'}</p>
    <dl className="summary">
      <div><dt>Registration reference</dt><dd>{receipt.reference}</dd></div>
      <div><dt>Student name</dt><dd>{receipt.name}</dd></div>
      <div><dt>Submitted</dt><dd>{dateLabel(receipt.submittedAt)}</dd></div>
    </dl>
    {complete ? <button className="primary full" onClick={() => downloadReceipt(receipt)}><Download size={17} /> Download receipt</button>
      : <button className="secondary full" onClick={refresh}>Check status <ArrowRight size={17} /></button>}
    {statusMessage && <p className="status-message" role="status">{statusMessage}</p>}
  </div>
}

export function App() {
  const reduceMotion = useReducedMotion()
  const [settings, setSettings] = useState<PortalConfig | null>(null)
  const [configAttempt, setConfigAttempt] = useState(0)
  const [configError, setConfigError] = useState(false)
  const [fields, setFields] = useState(initialFields)
  const [files, setFiles] = useState<Files>({})
  const [errors, setErrors] = useState<Errors>({})
  const [step, setStep] = useState(0)
  const [privacy, setPrivacy] = useState(false)
  const [challenge, setChallenge] = useState('')
  const [challengeAttempt, setChallengeAttempt] = useState(0)
  const [message, setMessage] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [phase, setPhase] = useState('')
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [receiptMessage, setReceiptMessage] = useState('')
  const key = useRef('')
  const recover = useRef(false)
  const inFlight = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    getConfig(controller.signal).then(setSettings, () => {
      if (!controller.signal.aborted) setConfigError(true)
    })
    return () => controller.abort()
  }, [configAttempt])

  useEffect(() => {
    if (receipt?.status !== 'pending') return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let polls = 0
    const poll = async () => {
      try {
        const current = await getReceipt(key.current, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]))
        if (current?.status === 'complete') {
          setReceiptMessage('')
          setReceipt(current)
          return
        }
        if (!current) {
          setReceiptMessage('This receipt is no longer available.')
          return
        }
      } catch {
        if (controller.signal.aborted) return
      }
      if (polls++ < 29) timer = setTimeout(poll, 4000)
      else setReceiptMessage('Processing is taking longer than usual. Keep your reference and use Check status to try again.')
    }
    timer = setTimeout(poll, 2500)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [receipt?.status])

  function focus(id: string) {
    requestAnimationFrame(() => document.getElementById(id)?.focus())
  }

  function move(next: number) {
    setMessage('')
    if (next < 2) setChallenge('')
    setStep(next)
    focus('form-title')
  }

  function clearError(name: string) {
    setErrors(old => {
      const updated = { ...old }
      delete updated[name]
      return updated
    })
  }

  function changeFile(kind: DocKey, file?: File) {
    if (file && (!['image/jpeg', 'image/png'].includes(file.type) || file.size < 1 || file.size > 5 * 1024 * 1024)) {
      setErrors(old => ({ ...old, [kind]: 'Choose a JPEG or PNG image, up to 5 MB.' }))
      return
    }
    setFiles(old => ({ ...old, [kind]: file }))
    clearError(kind)
  }

  function checkStep(index: number) {
    const problems: Errors = {}
    if (index === 0) {
      if (fields.name.trim().length < 2 || !/\p{L}/u.test(fields.name)) problems.name = 'Enter your complete name.'
      if (fields.roll.trim().length < 2 || !/[\p{L}\p{N}]/u.test(fields.roll)) problems.roll = 'Enter your complete roll number.'
      if (!fields.department) problems.department = 'Select your department.'
      if (!fields.semester) problems.semester = 'Select your semester.'
      if (!/^(?:0|\+92)3\d{9}$/.test(fields.mobile.normalize('NFKC').replace(/[\s()-]/g, ''))) {
        problems.mobile = 'Enter a Pakistani mobile number in local or +92 format.'
      }
    }
    if (index === 1) for (const { key, title } of documents) {
      if (!files[key]) problems[key] = `Add your ${title.toLowerCase()}.`
    }
    return problems
  }

  function showProblems(index: number, problems: Errors, description: string) {
    setErrors(problems)
    setStep(index)
    setMessage(description)
    focus('form-message')
  }

  function showReceipt(value: Receipt) {
    setReceipt(value)
    setFiles({})
    setFields(initialFields)
    setPrivacy(false)
    focus('form-title')
  }

  async function refreshReceipt() {
    try {
      const current = await getReceipt(key.current, AbortSignal.timeout(10_000))
      if (current) {
        setReceipt(current)
        setReceiptMessage(current.status === 'complete' ? '' : 'Processing is still in progress.')
      } else {
        setReceiptMessage('This receipt is no longer available.')
      }
    } catch {
      setReceiptMessage('Could not check the status. Please try again.')
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!settings || inFlight.current) return
    setMessage('')
    if (step < 2) {
      const problems = checkStep(step)
      if (Object.keys(problems).length) {
        showProblems(step, problems, step === 0 ? 'Check the highlighted details.' : 'Add the required documents.')
      } else {
        setErrors({})
        move(step + 1)
      }
      return
    }
    inFlight.current = true
    setPhase('Validating')
    try {
      key.current ||= crypto.randomUUID()
      if (recover.current) {
        const existing = await getReceipt(key.current, AbortSignal.timeout(10_000))
        if (existing) { showReceipt(existing); return }
      }
      for (const index of [0, 1]) {
        const problems = checkStep(index)
        if (Object.keys(problems).length) { showProblems(index, problems, 'Check the highlighted fields.'); return }
      }
      const problems: Errors = {}
      if (!privacy) problems.privacy = 'Acknowledge the privacy notice to continue.'
      if (settings.siteKey && !challenge) problems.challenge = 'Complete the security check to continue.'
      if (Object.keys(problems).length) { showProblems(2, problems, 'Check the highlighted items.'); return }

      const data = new FormData()
      for (const [name, value] of Object.entries(fields)) data.set(name, value)
      for (const { key: kind } of documents) data.set(kind, files[kind]!)
      data.set('privacy', 'yes')
      if (challenge) data.set('challenge', challenge)
      setProgress(0)
      setPhase('Uploading documents')
      recover.current = true
      const result = await submit(data, key.current, percentage => {
        setProgress(percentage)
        setPhase(percentage === null ? 'Finalizing registration' : 'Uploading documents')
      })
      showReceipt(result)
    } catch (error) {
      if (error instanceof ApiError) {
        setChallenge('')
        setChallengeAttempt(old => old + 1)
        const names = Object.keys(error.errors)
        const target = names.some(name => name in fields) ? 0 : names.some(name => documents.some(doc => doc.key === name)) ? 1 : 2
        showProblems(target, error.errors, error.message)
      } else {
        showProblems(2, {}, 'Could not check the registration. Please try again.')
      }
    } finally {
      setPhase('')
      setProgress(null)
      inFlight.current = false
    }
  }

  function inputProps(name: Detail, hint?: string) {
    return {
      id: name, name, value: fields[name], required: name !== 'category',
      'aria-invalid': !!errors[name],
      'aria-describedby': [hint ? `${name}-hint` : '', errors[name] ? `${name}-error` : ''].filter(Boolean).join(' ') || undefined,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        setFields(old => ({ ...old, [name]: event.target.value }))
        clearError(name)
      },
    }
  }

  function select(name: 'department' | 'semester' | 'category', options: string[], placeholder: string) {
    return <div className="select-wrap">
      <select {...inputProps(name)}><option value="">{placeholder}</option>{options.map(option => <option key={option}>{option}</option>)}</select>
      <ChevronDown size={16} aria-hidden="true" />
    </div>
  }

  return <MotionConfig reducedMotion="user">
    <header className="site-header" id="top">
      <div className="shell header-inner">
        <Brand />
        <a href="#registration" className="header-action">Register Now <ArrowUpRight size={16} aria-hidden="true" /></a>
      </div>
    </header>
    <main className="shell layout">
      <Introduction />
      <motion.section className="registration" id="registration" aria-labelledby="form-title"
        initial={reduceMotion ? false : { opacity: .88, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .23 }}>
        {receipt ? <ReceiptView receipt={receipt} refresh={refreshReceipt} statusMessage={receiptMessage} /> :
          <>
            <nav aria-label="Registration progress" className="steps">
              <ol>{stages.map(({ label }, index) => <li key={label} className={index === step ? 'current' : index < step ? 'visited' : ''}>
                <button type="button" disabled={index >= step || !!phase} aria-current={index === step ? 'step' : undefined} onClick={() => move(index)}>
                  <span className="step-number">{index < step ? <Check size={14} /> : index + 1}</span><span>{label}</span>
                </button>
              </li>)}</ol>
            </nav>
            <motion.div key={step} initial={reduceMotion ? false : { opacity: .7, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .16 }}>
              <div className="form-heading">
                <p className="step-count">STEP {step + 1} OF 3</p>
                <h2 id="form-title" tabIndex={-1}>{stages[step].title}</h2>
                <p>{stages[step].description}</p>
              </div>
              {message && <p className="form-message" id="form-message" tabIndex={-1} role="alert">{message}</p>}
              {!settings ? <div className="config-state" role="status">
                {configError ? <><p>Registration options are temporarily unavailable.</p><button type="button" className="secondary" onClick={() => { setConfigError(false); setConfigAttempt(old => old + 1) }}>Try again</button></> : <p>Loading registration options…</p>}
              </div> : <form noValidate onSubmit={handleSubmit}>
                <fieldset disabled={!!phase} className="step-fields" aria-label={stages[step].title}>
                  {step === 0 && <>
                    <Field name="name" label="Complete name" error={errors.name}>
                      <input {...inputProps('name')} placeholder="Enter your full name" maxLength={120} autoComplete="name" />
                    </Field>
                    <Field name="roll" label="Complete roll number" hint="Use the full roll number on your student ID." error={errors.roll}>
                      <input {...inputProps('roll', 'hint')} placeholder="e.g. Sp-26/BsSE/001" maxLength={80} spellCheck={false} />
                    </Field>
                    <div className="field-row">
                      <Field name="department" label="Department" error={errors.department}>{select('department', settings.departments, 'Select department')}</Field>
                      <Field name="semester" label="Semester" error={errors.semester}>{select('semester', settings.semesters, 'Select semester')}</Field>
                    </div>
                    <div className="field-row">
                      <Field name="mobile" label="Mobile number" hint="Local or +92 format" error={errors.mobile}>
                        <input {...inputProps('mobile', 'hint')} placeholder="e.g. 0300 1234567" maxLength={30} type="tel" autoComplete="tel" />
                      </Field>
                      <Field name="category" label="Category" optional error={errors.category}>{select('category', settings.categories, settings.categories.length ? 'Select category' : 'Not specified')}</Field>
                    </div>
                  </>}
                  {step === 1 && <>
                    <p className="upload-hint" id="uploads-hint"><FileImage size={16} /> JPEG or PNG · Up to 5 MB per image</p>
                    {documents.map(({ key: kind, title }) => <UploadControl key={kind} kind={kind} title={title} file={files[kind]} error={errors[kind]} change={file => changeFile(kind, file)} />)}
                  </>}
                  {step === 2 && <>
                    <div className="review-heading"><h3>Student details</h3><button type="button" className="text-button" onClick={() => move(0)}>Edit details</button></div>
                    <dl className="summary">
                      {Object.entries({ Name: fields.name, 'Roll number': fields.roll, Department: fields.department, Semester: fields.semester, Mobile: fields.mobile, Category: fields.category || 'Not specified' }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
                    </dl>
                    <div className="review-heading"><h3>Documents</h3><button type="button" className="text-button" onClick={() => move(1)}>Edit documents</button></div>
                    <ul className="review-docs">{documents.map(({ key: kind, title }) => <li key={kind}><Check size={14} /> {title}</li>)}</ul>
                    <div className="privacy">
                      <h3><LockKeyhole size={16} /> Privacy notice</h3>
                      <p id="privacy-notice">Your details and images are used to process your TAAKRA registration. Access is limited to the organizer and authorized staff. Records are scheduled for deletion after {settings.retentionDays} {settings.retentionDays === 1 ? 'day' : 'days'}.</p>
                      <label className="ack"><input type="checkbox" checked={privacy} required aria-describedby={errors.privacy ? 'privacy-notice privacy-error' : 'privacy-notice'}
                        onChange={event => { setPrivacy(event.target.checked); clearError('privacy') }} /> I acknowledge the privacy notice.</label>
                      {errors.privacy && <p className="field-error" id="privacy-error">{errors.privacy}</p>}
                    </div>
                    {settings.siteKey && <div className="challenge">
                      <Turnstile key={challengeAttempt} sitekey={settings.siteKey} action="register" theme="dark" size="compact"
                        onVerify={token => { setChallenge(token); clearError('challenge') }} onExpire={() => setChallenge('')} onError={() => setChallenge('')} />
                      {errors.challenge && <p className="field-error">{errors.challenge}</p>}
                    </div>}
                  </>}
                </fieldset>
                {phase && <div className="upload-progress" role="status">
                  <p>{phase}{progress === null ? '…' : ` · ${progress}%`}</p>
                  {progress !== null && <progress value={progress} max={100} aria-label="Document upload progress" />}
                </div>}
                <div className="form-actions">
                  {step > 0 && <button type="button" className="secondary" onClick={() => move(step - 1)} disabled={!!phase}><ArrowLeft size={17} /> Back</button>}
                  <button className="primary" type="submit" disabled={!!phase}>
                    {phase || (step === 2 ? 'Submit registration' : 'Continue')} <ArrowRight size={18} aria-hidden="true" />
                  </button>
                </div>
              </form>}
            </motion.div>
          </>}
        <div className="secure-note"><ShieldCheck size={15} aria-hidden="true" /> Private student registration</div>
      </motion.section>
    </main>
    <footer className="site-footer"><div className="shell footer-inner">
      <span>TAAKRA 2027 <i /> Student registration</span>
      <a href="#registration">Registration form <ArrowDown size={14} aria-hidden="true" /></a>
    </div></footer>
  </MotionConfig>
}
