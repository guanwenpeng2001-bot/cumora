import { useLayoutEffect, useRef, useState } from 'react'
import { api } from '@/api/client'
import { useAuth } from '@/stores/auth'
import { isApiAbortError } from './apiErrors'
import { translate, useLocale, useT } from './i18n'

export type VoiceState = 'idle' | 'requesting' | 'recording' | 'stopping' | 'transcribing' | 'error'

const FORMATS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'aac',
}

interface Operation {
  id: number
  scopeKey: string | null
  epoch: number
  phase: VoiceState
  controller: AbortController
  stream?: MediaStream
  recorder?: MediaRecorder
  interval?: ReturnType<typeof setInterval>
  deadline?: ReturnType<typeof setTimeout>
}

function releaseCapture(op: Operation) {
  clearInterval(op.interval)
  clearTimeout(op.deadline)
  op.interval = undefined
  op.deadline = undefined
  const recorder = op.recorder
  op.recorder = undefined
  if (recorder) {
    recorder.ondataavailable = null
    recorder.onstop = null
    recorder.onerror = null
    try { if (recorder.state !== 'inactive') recorder.stop() } catch { /* tracks still need releasing */ }
  }
  const stream = op.stream
  op.stream = undefined
  stream?.getTracks().forEach((track) => {
    try { track.stop() } catch { /* release the remaining tracks too */ }
  })
}

export function useVoiceInput(scopeKey: string | null, onText: (text: string) => void) {
  const t = useT()
  const locale = useLocale()
  const epoch = useAuth((s) => s.contextEpoch)
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [voiceSeconds, setVoiceSeconds] = useState(0)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const sequence = useRef(0)
  const active = useRef<Operation | null>(null)
  const context = useRef({ scopeKey, epoch, onText })
  const mounted = useRef(false)
  const errorTimer = useRef<ReturnType<typeof setTimeout>>()

  function cancel() {
    sequence.current++
    const op = active.current
    active.current = null
    if (op) {
      releaseCapture(op)
      op.controller.abort()
    }
    clearTimeout(errorTimer.current)
    if (mounted.current) {
      setVoiceState('idle')
      setVoiceSeconds(0)
      setVoiceError(null)
    }
  }

  useLayoutEffect(() => {
    context.current = { scopeKey, epoch, onText }
  })

  useLayoutEffect(() => {
    mounted.current = true
    cancel()
    const unsubscribe = useAuth.subscribe((state) => {
      if (active.current && state.contextEpoch !== active.current.epoch) cancel()
    })
    return () => {
      mounted.current = false
      unsubscribe()
      cancel()
    }
  }, [scopeKey, epoch])

  function current(op: Operation) {
    return mounted.current && active.current === op && sequence.current === op.id
      && context.current.scopeKey === op.scopeKey && context.current.epoch === op.epoch
      && useAuth.getState().contextEpoch === op.epoch && !op.controller.signal.aborted
  }

  function showError(message: string) {
    clearTimeout(errorTimer.current)
    setVoiceError(message)
    errorTimer.current = setTimeout(() => {
      setVoiceError(null)
      setVoiceState((state) => state === 'error' ? 'idle' : state)
    }, 4500)
  }

  function fail(op: Operation, error: unknown) {
    if (!current(op)) return
    const cancelled = isApiAbortError(error, op.controller.signal)
    cancel()
    if (cancelled) return
    const name = error instanceof Error ? error.name : ''
    const zh = locale === 'zh-CN'
    const messages: Record<string, string> = {
      NotAllowedError: translate(zh ? 'zh-CN' : 'en', 'settings.microphoneAccessDeniedAllowAccessAndTryAgain'),
      NotFoundError: translate(zh ? 'zh-CN' : 'en', 'settings.noMicrophoneFoundConnectOneAndTryAgain'),
      NotReadableError: translate(zh ? 'zh-CN' : 'en', 'settings.microphoneIsBusyOrUnreadableCheckTheDeviceAnd'),
      TimeoutError: translate(zh ? 'zh-CN' : 'en', 'settings.voiceInputTimedOutPleaseTryAgain'),
      NotSupportedError: t('chat.voiceNoSupport'),
    }
    const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : null
    setVoiceState('error')
    showError(status === 413
      ? (translate(zh ? 'zh-CN' : 'en', 'settings.recordingIsTooLargeRecordAShorterClipAnd'))
      : messages[name] ?? t('chat.voiceFailed'))
  }

  function deadline(op: Operation, ms: number) {
    clearTimeout(op.deadline)
    op.deadline = setTimeout(() => fail(op, new DOMException('Voice timeout', 'TimeoutError')), ms)
  }

  async function transcribe(op: Operation, blob: Blob) {
    if (!current(op)) return
    op.phase = 'transcribing'
    setVoiceState('transcribing')
    deadline(op, 60_000)
    try {
      if (!blob.size) throw new Error('Empty recording')
      const format = FORMATS[blob.type.split(';')[0].trim().toLowerCase()]
      if (!format) throw new DOMException('Unsupported audio format', 'NotSupportedError')
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (!current(op)) return
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      }
      const { text } = await api.transcribeAudio(btoa(binary), format, op.controller.signal)
      if (!current(op)) return
      if (text.trim()) context.current.onText(text.trim())
      cancel()
    } catch (error) {
      fail(op, error)
    }
  }

  function stop() {
    const op = active.current
    if (!op || !current(op) || op.phase !== 'recording') return
    op.phase = 'stopping'
    setVoiceState('stopping')
    clearInterval(op.interval)
    deadline(op, 10_000)
    try { op.recorder!.stop() } catch (error) { fail(op, error) }
  }

  async function start() {
    if (active.current || !mounted.current || !context.current.scopeKey) return
    clearTimeout(errorTimer.current)
    setVoiceError(null)
    setVoiceSeconds(0)
    const op: Operation = {
      id: ++sequence.current, scopeKey: context.current.scopeKey,
      epoch: useAuth.getState().contextEpoch, phase: 'requesting', controller: new AbortController(),
    }
    active.current = op
    setVoiceState('requesting')
    deadline(op, 60_000)
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new DOMException('Recording unavailable', 'NotSupportedError')
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      op.stream = stream
      if (!current(op)) { releaseCapture(op); return }
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
        .find((mime) => MediaRecorder.isTypeSupported(mime))
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      op.recorder = recorder
      const chunks: Blob[] = []
      recorder.ondataavailable = (event) => {
        if (current(op) && event.data.size > 0) chunks.push(event.data)
      }
      recorder.onerror = () => fail(op, new Error('Recording failed'))
      recorder.onstop = () => {
        if (!current(op) || op.phase === 'transcribing') return
        const type = recorder.mimeType || chunks[0]?.type || mimeType || ''
        releaseCapture(op)
        void transcribe(op, new Blob(chunks, { type }))
      }
      recorder.start()
      if (!current(op) || op.phase !== 'requesting') return
      op.phase = 'recording'
      setVoiceState('recording')
      clearTimeout(op.deadline)
      op.interval = setInterval(() => { if (current(op)) setVoiceSeconds((seconds) => seconds + 1) }, 1000)
      op.deadline = setTimeout(() => {
        if (!current(op)) return
        showError(t('chat.voiceMaxDuration'))
        stop()
      }, 120_000)
    } catch (error) {
      fail(op, error)
    }
  }

  function onVoiceClick() {
    if (active.current?.phase === 'recording') stop()
    else if (active.current?.phase === 'stopping') return
    else if (active.current) cancel()
    else void start()
  }

  const voiceActionLabel = voiceState === 'requesting' || voiceState === 'transcribing'
    ? (translate(locale, 'settings.cancelVoiceInput'))
    : voiceState === 'recording' || voiceState === 'stopping' ? t('chat.voiceStop') : t('chat.voiceInput')

  return { voiceState, voiceSeconds, voiceError, voiceActionLabel, onVoiceClick, start, stop, cancel }
}
