import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { MotionConfig, motion, useReducedMotion } from 'motion/react'
import { ArrowRight, ArrowUp, Check, Clock3, Download, FileImage, LockKeyhole, Mail, ShieldCheck } from 'lucide-react'
import Turnstile from 'react-turnstile'
import { fieldLengths, MAX_FILE, validateStudentFields } from '../server/student-fields'
import { ApiError, getConfig, getReceipt, submit, type PortalConfig, type Receipt } from './api'
import { Header, Hero } from './Hero'
import { documents, UploadControl, type DocumentKey } from './UploadControl'

const studentFields = {
  name: { label: 'Student’s Complete Name', placeholder: 'Enter your full name', autoComplete: 'name' },
  roll: { label: 'Complete Roll Number', placeholder: 'e.g. Sp-26/BsSE/001' },
  department: { label: 'Department', placeholder: 'Enter your department' },
  semester: { label: 'Semester', placeholder: 'e.g. 1 or First Semester' },
  mobile: { label: 'Mobile Number', placeholder: 'e.g. 03XXXXXXXXX', autoComplete: 'tel', hint: 'Use a local Pakistani number or the +92 format.' },
  category: { label: 'Category', placeholder: 'Enter your category, if applicable', hint: 'Optional — leave blank if not applicable.' },
}
type Detail = keyof typeof studentFields
const details = Object.keys(studentFields) as Detail[]
const initialFields = { name: '', roll: '', department: '', semester: '', mobile: '', category: '' }
type Files = Partial<Record<DocumentKey, File>>
type Errors = Record<string, string>
type Phase = 'Checking your details' | 'Uploading documents' | 'Finalizing registration' | ''

const pakistanTime = new Intl.DateTimeFormat('en-PK', {
  timeZone: 'Asia/Karachi', year: 'numeric', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
})

function Section({ id, letter, title, description, children }: {
  id: string; letter: string; title: string; description: string; children: ReactNode
}) {
  const reduced = useReducedMotion()
  return <motion.section id={id} className="form-section" aria-labelledby={`${id}-title`} tabIndex={-1}
    initial={reduced ? false : { opacity: .93, y: 4 }} whileInView={{ opacity: 1, y: 0 }}
    viewport={{ once: true }} transition={{ duration: .22 }}>
    <div className="section-heading">
      <span aria-hidden="true" className="section-letter">{letter}</span>
      <div><h3 id={`${id}-title`}>{title}</h3><p>{description}</p></div>
    </div>
    {children}
  </motion.section>
}

function downloadReceipt(receipt: Receipt) {
  const text = `TAAKRA 2027 — Registration receipt\n\nReference: ${receipt.reference}\nStudent: ${receipt.name}\nSubmitted (Asia/Karachi): ${pakistanTime.format(new Date(receipt.submittedAt))}\nStatus: Submitted for review\n`
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const link = window.document.createElement('a')
  link.href = url
  link.download = `${receipt.reference}-receipt.txt`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function ReceiptView({ receipt, refresh, statusMessage }: { receipt: Receipt; refresh: () => void; statusMessage: string }) {
  const complete = receipt.status === 'complete'
  const reduced = useReducedMotion()
  return <motion.div className="receipt-view" key={receipt.status}
    initial={reduced ? false : { opacity: .75, y: 8 }} animate={{ opacity: 1, y: 0 }}>
    <span className={`receipt-icon ${complete ? 'complete' : ''}`}>{complete ? <Check size={27} aria-hidden="true" /> : <Clock3 size={24} aria-hidden="true" />}</span>
    <h2 id="receipt-title" tabIndex={-1}>{complete ? 'Registration submitted' : 'Received — processing'}</h2>
    <p role="status">{complete ? 'Your registration has been submitted for review.' : 'Your registration has been received and is being processed.'}</p>
    <dl className="receipt-details">
      <div><dt>Registration reference</dt><dd>{receipt.reference}</dd></div>
      <div><dt>Student name</dt><dd>{receipt.name}</dd></div>
      <div><dt>Submitted (Pakistan time)</dt><dd><time dateTime={receipt.submittedAt}>{pakistanTime.format(new Date(receipt.submittedAt))}</time></dd></div>
    </dl>
    {complete
      ? <button type="button" className="primary" onClick={() => downloadReceipt(receipt)}><Download size={17} aria-hidden="true" /> Download receipt</button>
      : <button type="button" className="secondary" onClick={refresh}>Check status <ArrowRight size={17} aria-hidden="true" /></button>}
    {statusMessage && <p className="status-message" role="status">{statusMessage}</p>}
  </motion.div>
}

function Footer({ settings }: { settings: PortalConfig | null }) {
  return <footer className="site-footer">
    <div className="shell footer-inner">
      <span className="footer-brand">TAAKRA <em>2027</em></span>
      {settings && (settings.organizerName || settings.organizerEmail) && <div className="organizer">
        {settings.organizerName && <span>Organized by {settings.organizerName}</span>}
        {settings.organizerEmail && <a href={`mailto:${settings.organizerEmail}`}><Mail size={15} aria-hidden="true" /> Contact organizer</a>}
      </div>}
      <a className="back-top" href="#top">Back to top <ArrowUp size={15} aria-hidden="true" /></a>
    </div>
  </footer>
}

function focus(id: string, scroll = true) {
  requestAnimationFrame(() => {
    const target = window.document.getElementById(id)
    target?.focus({ preventScroll: true })
    if (scroll) target?.scrollIntoView({ block: 'nearest' })
  })
}

export function App() {
  const reduced = useReducedMotion()
  const [settings, setSettings] = useState<PortalConfig | null>(null)
  const [configAttempt, setConfigAttempt] = useState(0)
  const [configError, setConfigError] = useState(false)
  const [fields, setFields] = useState(initialFields)
  const [files, setFiles] = useState<Files>({})
  const [errors, setErrors] = useState<Errors>({})
  const [privacy, setPrivacy] = useState(false)
  const [challenge, setChallenge] = useState('')
  const [challengeAttempt, setChallengeAttempt] = useState(0)
  const [message, setMessage] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [phase, setPhase] = useState<Phase>('')
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [receiptMessage, setReceiptMessage] = useState('')
  const key = useRef('')
  const recover = useRef(false)
  const inFlight = useRef(false)
  const { fields: summary } = validateStudentFields(fields)

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
          focus('receipt-title', false)
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
      else setReceiptMessage('Processing is taking longer than usual. Keep your reference and check again.')
    }
    timer = setTimeout(poll, 2500)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [receipt?.status])

  function clearError(name: string) {
    setErrors(old => {
      if (!old[name]) return old
      const updated = { ...old }
      delete updated[name]
      return updated
    })
  }

  function changeFile(kind: DocumentKey, file?: File) {
    if (file && (!['image/jpeg', 'image/png'].includes(file.type) || file.size < 1 || file.size > MAX_FILE)) {
      const message = 'Choose a JPEG or PNG image, up to 5 MB.'
      setErrors(old => ({ ...old, [kind]: files[kind] ? `${message} The previous image is still attached.` : message }))
      return
    }
    setFiles(old => ({ ...old, [kind]: file }))
    clearError(kind)
  }

  function showProblems(problems: Errors, description: string) {
    setErrors(problems)
    setMessage(description)
    const first = [...details, ...documents.map(item => item.key), 'privacy', 'challenge']
      .find(field => problems[field])
    focus(first ?? 'form-message')
  }

  function showReceipt(value: Receipt) {
    setReceipt(value)
    setFiles({})
    setFields(initialFields)
    setPrivacy(false)
    setChallenge('')
    focus('receipt-title')
  }

  async function refreshReceipt() {
    try {
      const current = await getReceipt(key.current, AbortSignal.timeout(10_000))
      if (current) {
        setReceipt(current)
        setReceiptMessage(current.status === 'complete' ? '' : 'Processing is still in progress.')
        if (current.status === 'complete') focus('receipt-title', false)
      } else {
        setReceiptMessage('This receipt is no longer available.')
      }
    } catch {
      setReceiptMessage('Could not check the status. Please try again.')
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!settings || inFlight.current) return
    setMessage('')
    inFlight.current = true
    try {
      key.current ||= crypto.randomUUID()
      if (recover.current) {
        setPhase('Checking your details')
        const existing = await getReceipt(key.current, AbortSignal.timeout(10_000))
        if (existing) { showReceipt(existing); return }
      }

      const { errors: problems } = validateStudentFields(fields)
      for (const document of documents) {
        if (!files[document.key]) problems[document.key] = `Add your ${document.name}.`
      }
      if (!privacy) problems.privacy = 'Confirm your information and acknowledge the privacy notice.'
      if (settings.siteKey && !challenge) problems.challenge = 'Complete the security check to continue.'
      if (Object.keys(problems).length) { showProblems(problems, 'Check the highlighted fields.'); return }
      setErrors({})

      const data = new FormData()
      for (const name of details) data.set(name, fields[name])
      for (const { key: kind } of documents) data.set(kind, files[kind]!)
      data.set('privacy', 'yes')
      if (challenge) data.set('challenge', challenge)

      setPhase('Checking your details')
      recover.current = true
      const result = await submit(data, key.current, percentage => {
        setProgress(percentage)
        setPhase(percentage === null ? 'Finalizing registration' : 'Uploading documents')
      }, () => setPhase('Uploading documents'))
      showReceipt(result)
    } catch (error) {
      setChallenge('')
      setChallengeAttempt(old => old + 1)
      if (error instanceof ApiError) showProblems(error.errors, error.message)
      else showProblems({}, 'Could not check the registration. Please try again.')
    } finally {
      setPhase('')
      setProgress(null)
      inFlight.current = false
    }
  }

  function input(name: Detail) {
    const item = studentFields[name]
    const hint = 'hint' in item ? item.hint : ''
    const describedBy = [hint ? `${name}-hint` : '', errors[name] ? `${name}-error` : ''].filter(Boolean).join(' ')
    return <div className="field" key={name}>
      <label htmlFor={name}>{item.label} {name === 'category' ? <span className="optional">Optional</span> : <span className="required" aria-hidden="true">*</span>}</label>
      <input id={name} name={name} value={fields[name]} required={name !== 'category'}
        type={name === 'mobile' ? 'tel' : 'text'} inputMode={name === 'mobile' ? 'tel' : undefined}
        autoComplete={'autoComplete' in item ? item.autoComplete : 'off'} spellCheck={name !== 'roll'}
        maxLength={fieldLengths[name]} placeholder={item.placeholder} aria-invalid={!!errors[name]}
        aria-describedby={describedBy || undefined}
        onChange={event => { setFields(old => ({ ...old, [name]: event.target.value })); clearError(name) }} />
      {hint && <p className="field-hint" id={`${name}-hint`}>{hint}</p>}
      {errors[name] && <p className="field-error" id={`${name}-error`}>{errors[name]}</p>}
    </div>
  }

  function upload(index: number) {
    const document = documents[index]
    return <UploadControl key={document.key} document={document} file={files[document.key]} error={errors[document.key]}
      onChange={file => changeFile(document.key, file)} />
  }

  return <MotionConfig reducedMotion="user">
    <Header />
    <main>
      <Hero />
      <section className="registration-section" id="registration" tabIndex={-1} aria-labelledby={receipt ? 'receipt-title' : 'form-title'}>
        <motion.div className="form-shell" initial={reduced ? false : { opacity: .88, y: 8 }}
          whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: .25 }}>
          {receipt ? <>
            <ReceiptView receipt={receipt} refresh={refreshReceipt} statusMessage={receiptMessage} />
            <section className="receipt-guidance" id="requirements" aria-labelledby="requirements-title">
              <h3 id="requirements-title">Required Documents</h3>
              <p>Passport-size photograph, student ID card, and the front and back of your CNIC. JPEG or PNG, up to 5 MB per image.</p>
            </section>
          </> : <>
            <div className="registration-heading">
              <div><h2 id="form-title">Student registration</h2><p>Have your student details and four document images ready.</p></div>
              <span className="required-key"><span className="required" aria-hidden="true">*</span> Required fields</span>
            </div>
            <form className="registration-form" noValidate onSubmit={handleSubmit}>
              <fieldset className="form-fields" disabled={!!phase}>
                <Section id="student-information" letter="A" title="Student Information" description="Enter your details as they appear in your student records.">
                  <div className="input-grid">
                    {input('name')}{input('roll')}{input('department')}{input('semester')}{input('mobile')}{input('category')}
                  </div>
                </Section>
                <Section id="requirements" letter="B" title="Required Documents" description="Use clear, readable images with all edges and details visible.">
                  <p className="upload-guidance" id="upload-guidance"><FileImage size={16} aria-hidden="true" /> JPEG or PNG · Up to 5 MB per image</p>
                  <div className="upload-grid">{upload(0)}{upload(1)}</div>
                  <fieldset className="cnic-group">
                    <legend>CNIC</legend>
                    <div className="upload-grid">{upload(2)}{upload(3)}</div>
                  </fieldset>
                </Section>
                <Section id="review" letter="C" title="Review and Submit" description="Check your details and make sure the four images are attached.">
                  <div className="review-box">
                    <dl className="review-details">
                      <div><dt>Name</dt><dd>{summary.name || '—'}</dd></div>
                      <div><dt>Roll number</dt><dd>{summary.roll || '—'}</dd></div>
                      <div><dt>Department</dt><dd>{summary.department || '—'}</dd></div>
                      <div><dt>Semester</dt><dd>{summary.semester || '—'}</dd></div>
                      <div><dt>Mobile</dt><dd>{summary.mobile || fields.mobile.trim() || '—'}</dd></div>
                      <div><dt>Category</dt><dd>{summary.category}</dd></div>
                    </dl>
                    <div className="review-meta">
                      <p>{documents.filter(item => files[item.key]).length} of 4 documents attached</p>
                      <button type="button" className="text-button" onClick={() => focus('name')}>Edit student details</button>
                    </div>
                  </div>
                  <div className="privacy">
                    <h4><LockKeyhole size={16} aria-hidden="true" /> Privacy notice</h4>
                    <p id="privacy-notice">{settings ? `Your details and images are used to process your TAAKRA registration. Only the organizer and authorized staff can access them. Records are scheduled for deletion after ${settings.retentionDays} ${settings.retentionDays === 1 ? 'day' : 'days'}.` : 'Loading the organizer’s retention policy…'}</p>
                    <label className="ack"><input id="privacy" type="checkbox" checked={privacy} required
                      aria-invalid={!!errors.privacy} aria-describedby={errors.privacy ? 'privacy-notice privacy-error' : 'privacy-notice'}
                      onChange={event => { setPrivacy(event.target.checked); clearError('privacy') }} /> I confirm my information is correct and I have read the privacy notice.</label>
                    {errors.privacy && <p className="field-error" id="privacy-error">{errors.privacy}</p>}
                  </div>
                  {settings?.siteKey && <div id="challenge" className="challenge" tabIndex={-1} aria-label="Registration security check">
                    <Turnstile key={challengeAttempt} sitekey={settings.siteKey} action="register" theme="dark" size="compact"
                      onVerify={token => { setChallenge(token); clearError('challenge') }}
                      onExpire={() => setChallenge('')} onError={() => setChallenge('')} />
                    {errors.challenge && <p className="field-error">{errors.challenge}</p>}
                  </div>}
                </Section>
              </fieldset>

              <div className="form-end">
                {message && <p className="form-message" id="form-message" tabIndex={-1} role="alert">{message}</p>}
                {!settings && <div className="config-state" role="status">
                  {configError ? <><p>Registration settings are temporarily unavailable.</p><button type="button" className="secondary" onClick={() => { setConfigError(false); setConfigAttempt(old => old + 1) }}>Try again</button></> : <p>Loading registration settings…</p>}
                </div>}
                <div className="submit-row">
                  <button className="primary" type="submit" disabled={!!phase || !settings}>Submit Registration <ArrowRight size={18} aria-hidden="true" /></button>
                  <span className="secure-note"><ShieldCheck size={17} aria-hidden="true" /> Private student registration</span>
                </div>
                <div className="upload-progress" role="status">
                  {phase && <p>{phase}{progress === null ? '…' : ` · ${progress}%`}</p>}
                </div>
                {progress !== null && <progress className="upload-meter" value={progress} max={100} aria-label="Document upload progress" />}
              </div>
            </form>
          </>}
        </motion.div>
      </section>
    </main>
    <Footer settings={settings} />
  </MotionConfig>
}
