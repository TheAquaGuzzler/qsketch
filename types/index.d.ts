/** One numbered marker's note, as the editor sends it. */
export type QsketchNote = { n: number; text: string }

/** An annotated screenshot waiting to go out with the next message. */
export type QsketchAttachment = {
  id: string
  /** Absolute path of the PNG, inside the attachments folder. */
  png: string
  width: number
  height: number
  notes: QsketchNote[]
  comment: string
  /** How many marks of each kind the picture has (`arrow: 2`). */
  marks: Record<string, number>
  /** A small JPEG data URL for the band, or '' when there is none. */
  thumb: string
}

/** What the band says about the editor helper. */
export type QsketchStatus = {
  phase: 'idle' | 'starting' | 'ready' | 'error'
  message: string
}

/** What went out with the last message the person sent: the band confirms it. */
export type QsketchSent = {
  at: number
  items: QsketchAttachment[]
}

declare module 'claude-code' {
  interface PluginState {
    qsketch: {
      pending: QsketchAttachment[]
      status: QsketchStatus
      sent: QsketchSent | null
    }
  }
}
