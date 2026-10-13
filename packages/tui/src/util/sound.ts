/// <reference path="../audio.d.ts" />
import * as TuiAudio from "../audio"
import pulseA from "../asset/pulse-a.wav" with { type: "file" }
import pulseB from "../asset/pulse-b.wav" with { type: "file" }
import pulseC from "../asset/pulse-c.wav" with { type: "file" }
import charge from "../asset/charge.wav" with { type: "file" }

const FILE = [pulseA, pulseB, pulseC]
const HUM = charge

let humVoice: number | undefined
let seq = 0
let shot = 0

export function start() {
  stop()
  const id = ++seq
  void TuiAudio.loadSoundFile(HUM).then((sound) => {
    if (id !== seq || !sound) return
    humVoice = TuiAudio.play(sound, { volume: 0.24, loop: true }) ?? undefined
  })
}

export function stop() {
  seq++
  if (humVoice === undefined) return
  TuiAudio.stopVoice(humVoice)
  humVoice = undefined
}

export function pulse(scale = 1) {
  const index = shot++ % FILE.length
  void TuiAudio.loadSoundFile(FILE[index]!).then((sound) => {
    if (!sound) return
    TuiAudio.play(sound, { volume: 0.26 + 0.14 * scale })
  })
}

export function dispose() {
  stop()
}
