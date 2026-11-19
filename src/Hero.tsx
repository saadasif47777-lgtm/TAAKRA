import { ArrowDown, ArrowUpRight, Flame } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'

function Brand() {
  return <a className="brand" href="#top" aria-label="TAAKRA 2027 home">
    <span className="brand-icon"><Flame size={17} fill="currentColor" strokeWidth={1.5} aria-hidden="true" /></span>
    <span>TAAKRA <em>2027</em></span>
  </a>
}

export function Header() {
  return <header className="site-header" id="top">
    <a className="skip-link" href="#registration">Skip to registration</a>
    <div className="shell header-inner">
      <Brand />
      <nav aria-label="Main navigation">
        <a href="#registration" className="header-action">Register Now <ArrowUpRight size={16} aria-hidden="true" /></a>
      </nav>
    </div>
  </header>
}

const heroEntrance = {
  hidden: { opacity: 0.84, y: 9 },
  visible: { opacity: 1, y: 0 },
}

export function Hero() {
  const reduced = useReducedMotion()
  return <section className="hero" aria-labelledby="hero-title">
    <div className="shell hero-layout">
      <motion.div className="hero-copy" initial={reduced ? false : 'hidden'} animate="visible"
        transition={{ staggerChildren: 0.06 }}>
        <motion.p className="eyebrow" variants={heroEntrance}>TAAKRA 2027 · Student Registration</motion.p>
        <motion.h1 variants={heroEntrance} id="hero-title">Step into <em>the arena.</em></motion.h1>
        <motion.p variants={heroEntrance} className="hero-description">
          Register for TAAKRA 2027. Enter your student details and upload the required documents to submit your registration.
        </motion.p>
        <motion.div variants={heroEntrance} className="hero-actions">
          <a className="primary" href="#registration">Register Now <ArrowUpRight size={17} aria-hidden="true" /></a>
          <a className="hero-link" href="#requirements">View Requirements <ArrowDown size={15} aria-hidden="true" /></a>
        </motion.div>
      </motion.div>
      <motion.div className="hero-art" initial={reduced ? false : { opacity: .88 }} animate={{ opacity: 1 }}
        transition={{ duration: .4 }}>
        <motion.img src="/taakra-art.webp" alt="Two black stone bulls face each other across a molten orange fissure"
          width="1152" height="768" fetchPriority="high"
          whileHover={reduced ? undefined : { scale: 1.013 }} transition={{ duration: .45 }} />
      </motion.div>
    </div>
  </section>
}
