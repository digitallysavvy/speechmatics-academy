#!/usr/bin/env python3
"""Wall of Voices: the terminal edition.

Point a microphone at a room and Melia tags every word with the language it was
spoken in, mid-sentence, with no language list and no configuration:

    so[en] the[en] point[en] is[en] това[bg] е[bg] демо[bg]

This file has a server-side microphone, which is why it can use the SDK at all.
The web app cannot: its microphone is in the browser, so Python only mints a key
there. See the README under "How It Works".

    pip install -r requirements.txt
    python cli.py

Ctrl+C stops, flushes the last utterance out of Melia, and prints a summary.
"""

import asyncio
import os
import sys
from collections import Counter
from pathlib import Path

from dotenv import load_dotenv

from speechmatics.rt import (
    AsyncClient,
    AudioEncoding,
    AudioFormat,
    AuthenticationError,
    Microphone,
    ServerMessageType,
    TranscriptionConfig,
    TranscriptionError,
    TranscriptResult,
)

# Load by path rather than by search, so `python cli.py` works from any working
# directory. Values already in the environment win.
ENV_PATH = Path(__file__).with_name(".env")
load_dotenv(ENV_PATH)

# A Windows console defaults to cp1252, which cannot encode a single Cyrillic or
# Arabic character. Without this the demo dies on a UnicodeEncodeError the
# moment it succeeds.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# Melia preview endpoint: a third host, distinct from both the public eu.rt/us.rt
# tables and the SDK's own eu2.rt default. The SDK will not find it for you.
MELIA_RT_URL = "wss://preview.rt.speechmatics.com/v2"

# Melia wants 16 kHz mono PCM. 4096 bytes is 2048 samples, ~128 ms per frame.
SAMPLE_RATE = 16_000
CHUNK_BYTES = 4096

# How long to wait, after Ctrl+C, for Melia to flush the audio it still holds.
# Finals lag 3-6 s, so without this the last thing anybody said never arrives.
FLUSH_TIMEOUT_SECONDS = 8.0


def select_audio_device() -> int | None:
    """Ask which microphone to use. Returns a PyAudio index, or None for default."""
    devices = Microphone.list_devices()

    if not devices:
        return None

    print("Available microphones:")
    for device in devices:
        print(f"  [{device['index']}] {device['name']} ({device['channels']} channels)")
    print()

    while True:
        try:
            choice = input("Enter device index (or press Enter for default): ").strip()
            if not choice:
                return None  # Use default

            device_index = int(choice)
            if any(d["index"] == device_index for d in devices):
                return device_index
            else:
                print(f"Invalid device index. Choose from: {[d['index'] for d in devices]}")
        except ValueError:
            print("Please enter a valid number.")
        except (EOFError, KeyboardInterrupt):
            # No terminal to prompt on (piped stdin, CI), or the reader gave up.
            # The default device beats crashing before a word is transcribed.
            print()
            return None


def tag_words(result: TranscriptResult) -> tuple[str, list[str]]:
    """Render one transcript as `word[lang]` tokens, and list the languages in it.

    The per-word language lives at `results[i].alternatives[0].language`, on
    partials as well as finals, and changes *within* a sentence;
    `result.metadata.transcript`, the flat string most examples print, has
    already thrown it away. Languages come back in spoken order, with repeats.
    """
    tokens: list[str] = []
    languages: list[str] = []

    for item in result.results or []:
        alternative = item.alternatives[0] if item.alternatives else None
        if alternative is None:
            continue

        # Punctuation has no language of its own; Melia marks it as attaching to
        # the word before it. Glue it on rather than give it a token, so the line
        # reads as "това[bg]," the way it was spoken.
        if item.type == "punctuation" or item.attaches_to == "previous":
            if tokens:
                tokens[-1] += alternative.content
            continue

        language = alternative.language
        tokens.append(f"{alternative.content}[{language or '??'}]")
        if language:
            languages.append(language)

    return " ".join(tokens), languages


def print_summary(transcript_parts: list[str], language_counts: Counter[str]) -> None:
    """Print the whole transcript and the languages Melia found in it."""
    print("\n--- session summary ---")

    # Join with a space: Melia's fragments arrive without leading spaces, so
    # concatenating them directly, as the SDK example does, produces
    # "a voicetechnology company" at every segment boundary.
    transcript = " ".join(part.strip() for part in transcript_parts if part.strip())
    print(f"transcript: {transcript}" if transcript else "transcript: (nothing was transcribed)")

    if language_counts:
        tally = ", ".join(f"{language} ({count} words)" for language, count in language_counts.most_common())
        print(f"languages:  {len(language_counts)} -- {tally}")
    else:
        print("languages:  none detected")


async def main() -> None:
    """Stream this machine's microphone to Melia and print every word with its language."""
    api_key = os.getenv("SPEECHMATICS_API_KEY")
    if not api_key:
        print("Error: SPEECHMATICS_API_KEY not set")
        print(f"Copy .env.example to {ENV_PATH} and put your key in it, or export it in your shell.")
        print("The key needs access to the Melia preview.")
        return

    audio_format = AudioFormat(
        encoding=AudioEncoding.PCM_S16LE,
        chunk_size=CHUNK_BYTES,
        sample_rate=SAMPLE_RATE,
    )

    transcription_config = TranscriptionConfig(
        language="multi",
        model="melia-1",
        enable_partials=True,
    )

    selected_device = select_audio_device()

    mic = Microphone(
        sample_rate=audio_format.sample_rate,
        chunk_size=audio_format.chunk_size,
        device_index=selected_device,
    )

    if not mic.start():
        print("PyAudio not installed - microphone not available")
        print("Install with: pip install pyaudio")
        return

    transcript_parts: list[str] = []
    language_counts: Counter[str] = Counter()
    languages_seen: set[str] = set()

    def announce_new_languages(languages: list[str]) -> None:
        """Print a line the first time each language turns up in this session."""
        fresh = []
        for language in languages:
            if language not in languages_seen:
                languages_seen.add(language)
                fresh.append(language)
        if fresh:
            print(f"[+lang]   {' '.join(fresh)}  (this session: {' '.join(sorted(languages_seen))})")

    try:
        async with AsyncClient(api_key=api_key, url=MELIA_RT_URL) as client:

            @client.on(ServerMessageType.ADD_PARTIAL_TRANSCRIPT)
            def handle_partial_transcript(message: dict) -> None:
                line, languages = tag_words(TranscriptResult.from_message(message))
                if not line:
                    return
                print(f"[partial] {line}")
                announce_new_languages(languages)

            @client.on(ServerMessageType.ADD_TRANSCRIPT)
            def handle_final_transcript(message: dict) -> None:
                result = TranscriptResult.from_message(message)
                if result.metadata.transcript:
                    transcript_parts.append(result.metadata.transcript)

                line, languages = tag_words(result)
                if not line:
                    return
                print(f"[final]   {line}")
                # Finals only: a partial repeats the words of the final that
                # follows it, so counting both doubles every number.
                language_counts.update(languages)
                announce_new_languages(languages)

            await client.start_session(
                transcription_config=transcription_config,
                audio_format=audio_format,
            )

            print("\nMicrophone open - speak in any language, and switch language mid-sentence.")
            print("Press Ctrl+C to stop.\n")

            try:
                while True:
                    frame = await mic.read(audio_format.chunk_size)
                    await client.send_audio(frame)
            except (asyncio.CancelledError, KeyboardInterrupt):
                # Ctrl+C. asyncio.run cancels this task, which surfaces as
                # CancelledError; older runners raise KeyboardInterrupt instead.
                print("\nStopping - waiting for the last few seconds of audio...")
                mic.stop()
                try:
                    await asyncio.wait_for(client.stop_session(), timeout=FLUSH_TIMEOUT_SECONDS)
                except Exception:
                    print("(the connection closed before the last words came back)")
    except AuthenticationError as e:
        print(f"\nAuthentication failed: {e}")
        print("Check SPEECHMATICS_API_KEY, and that the key has access to the Melia preview.")
    except TranscriptionError as e:
        print(f"\nMelia rejected the session: {e}")
        print("Its realtime config is exactly language, model and enable_partials. Anything else fails validation.")
    except TimeoutError:
        print("\nMelia did not start the session within 5 seconds.")
        print("The usual cause is an API key without access to the Melia preview. The endpoint")
        print("accepts the connection first and simply never replies. A blocked wss:// looks the same.")
    except Exception as e:
        # Include the type: several errors reachable from here stringify to
        # nothing at all.
        print(f"\nTranscription error: {type(e).__name__}: {e}")
    finally:
        mic.stop()
        print_summary(transcript_parts, language_counts)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
