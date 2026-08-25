# Melia Multilingual Transcription

**Transcribe a multilingual recording with Melia, Speechmatics' multilingual speech-to-text model, over the Batch API. Set the model to "melia-1" and the language to "multi", and a recording that moves between languages comes back as one continuous transcript.**

Melia handles code-switching across 55+ languages in a single file, with no language to choose in advance and no language packs to manage. This example sends the minimal job config with the `speechmatics-batch` SDK and prints the transcript.

## What You'll Learn

- **How to select Melia**: the entire change is `model: "melia-1"` and `language: "multi"` in the transcription config.
- **The minimal Batch SDK flow**: submit a job and wait for the finished transcript in two calls, with the SDK handling the waiting.

## Prerequisites

- **Python 3.12+**
- **Speechmatics API Key**. Sign up at [portal.speechmatics.com](https://portal.speechmatics.com/) and create a key under **API Keys**.
- **An audio file**. Any supported format (WAV, MP3, M4A, FLAC, OGG). Use a recording that switches between languages to see Melia at its best.

## Quick Start

### Python

**Step 1: Create and activate a virtual environment**

**On Windows:**
```bash
cd python
python -m venv .venv
.venv\Scripts\activate
```

**On Mac/Linux:**
```bash
cd python
python3 -m venv .venv
source .venv/bin/activate
```

**Step 2: Install dependencies**

```bash
pip install -r requirements.txt
```

**Step 3: Configure environment**

```bash
cp ../.env.example ../.env
# Edit ../.env and add your real API key
```

**Step 4: Run it**

```bash
python main.py path/to/your-audio.wav
```

If you place a file at `assets/sample.m4a`, you can also run `python main.py` with no arguments.

## How It Works

The config is the whole story. This is what Melia needs:

```json
{
  "type": "transcription",
  "transcription_config": {
    "model": "melia-1",
    "language": "multi"
  }
}
```

`main.py` submits that config with the audio file, waits for the job to finish, prints the plain-text transcript, then lists the languages Melia tagged across the words:

```python
melia = TranscriptionConfig(language="multi", model=Model.MELIA_1)

job = await client.submit_job(audio_file, transcription_config=melia)
transcript = await client.wait_for_completion(job.id, format_type=FormatType.TXT)
print(transcript)

# Melia tags each word with the language it was recognized in.
result = await client.get_transcript(job.id, format_type=FormatType.JSON)
```

`wait_for_completion` does the waiting for you, so there is no polling loop to write. It checks once immediately and then every `polling_interval` seconds (default `5.0`), so pass a smaller interval if you are measuring how fast a job returns.

If you would rather not manage the job in two calls, `client.transcribe()` wraps `submit_job` and `wait_for_completion` and returns a `Transcript` object:

```python
result = await client.transcribe(audio_file, transcription_config=melia)
print(result.transcript_text)
```

One caveat if you take that route: Melia populates a `speaker` field on every word even when you have not asked for diarization, and `Transcript.transcript_text` prefixes each speaker's run with a label. The transcript then starts with `SPEAKER UU: `. Requesting `FormatType.TXT`, as this example does, returns clean text instead.

## Expected Output

For the bundled sample, which switches from English into Latvian partway through:

```
Speechmatics is a voice technology company that helps people and businesses work with spoken language in a smarter, faster, and more efficient way. Instead of leaving speech only as audio, it turns conversations, recordings, meetings, interviews and podcasts and live voice into useful digital texts. Lielākā vērtība ir tā spēja padarīt runu pieejamu un vieglāku izmantojamu ikdienas darbā. Tas palīdz uzņēmumiem attaupīt laiku, uzlabot saziņu un veidot pakalpojumus, kas labāk saprot dažādas balsis.

Languages detected: en, lv
```

Two things to notice. The whole recording comes back as one continuous piece of text, and the switch from English into Latvian happens mid-transcript without a second job, a second config, or a language chosen in advance. And the language tags are read back out of the result rather than being something you told the API to expect — `multi` is the only language you named.

Exact wording will drift as the model is updated, so treat the transcript above as indicative rather than a fixture to diff against.

## Key Features Demonstrated

- **One model, many languages**: a single config transcribes mixed-language audio without selecting a language up front.
- **Code-switching**: the transcript stays continuous across language changes within a recording.
- **Per-word language tags**: the json-v2 result carries a `language` field on each word's first alternative, and this example reads it to report which languages actually appeared. Note the lag at a switch, described under Expected Output.

## Configuration Options

- **Diarization**: pass `diarization="speaker"` to `TranscriptionConfig` to label speakers. Melia accepts this. Labels arrive on each word's `alternatives[0].speaker`; the top-level `Transcript.speakers` list is not populated.
- **Language hints**: `language_hints=["en", "lv"]` and `language_hints_strict` are accepted on Melia and bias recognition toward the languages you name.
- **Output format**: this example requests `FormatType.TXT` for plain text. Use `FormatType.JSON` to get word-level timings, speaker labels, and the `language` tag on every word.

### Not available on Melia

Melia is a different model rather than a drop-in replacement, and the Batch API **rejects the job at submission** — a `400`, not a silent ignore — if you send a feature it does not support. Confirmed rejections: `translation_config`, `additional_vocab`, `punctuation_overrides`, `audio_filtering_config`, `audio_events_config`, entity detection, and summarization. If you need translation, transcribe with Melia and translate downstream, or use Enhanced for that job.

## Troubleshooting

**`SPEECHMATICS_API_KEY not set`**
- Add your key to `.env` (copied from `.env.example`), or export it in your shell.

**`model must be one of ...`**
- Model identifiers can change over time. Confirm the current name for Melia in the [models documentation](https://docs.speechmatics.com/), and check that your `speechmatics-batch` version is 0.5.0 or newer — `Model.MELIA_1` does not exist in earlier releases.

**`Cannot specify both 'model' and 'operating_point'`**
- `model` replaces the deprecated `operating_point`. Remove `operating_point` from your `TranscriptionConfig`.

**`Additional property <name> is not allowed`**
- You have combined Melia with a feature it does not support. See "Not available on Melia" above.

**`No such file` or a file error**
- Pass a path to an audio file as the first argument (`python main.py path/to/audio.wav`), or place one at `assets/sample.m4a`.

**The transcript looks single-language**
- The recording may be in one language. Melia still transcribes it; try a clip that switches languages to see code-switching in a single transcript.

**`Languages detected` lists fewer languages than the recording contains**
- Language labelling can miss a switch even when the transcript itself is correct. Check the transcript text first to confirm the other language was recognized. To narrow it down, submit a clip of just the missing language: if that returns the right tag, the detector is fine and it is the switch in your audio that is not being caught — a short pause between languages in continuous audio is the common cause.

## Resources

- [Speechmatics documentation](https://docs.speechmatics.com/)
- [Speechmatics Batch API reference](https://docs.speechmatics.com/jobsapi)
- [Supported languages](https://docs.speechmatics.com/introduction/supported-languages)
- [Speechmatics Portal](https://portal.speechmatics.com/)

---

## Feedback

Help us improve this guide:
- Found an issue? [Report it](https://github.com/speechmatics/speechmatics-academy/issues)
- Have suggestions? [Open a discussion](https://github.com/orgs/speechmatics/discussions/categories/academy)

---

**Time to Complete**: 5 minutes
**Difficulty**: Beginner
**API Mode**: Batch
**Languages**: Python

[Back to Basics](../) | [Back to Academy](../../README.md)
