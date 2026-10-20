# Runtime performance

## Current dictation pipeline

On 20 October 2026 the default formatter changed from Qwen3.5 4B to
[Spokenly Cleanup 1](https://huggingface.co/spokenly/cleanup-1-gguf), a 0.6B
dictation-specific fine-tune, Q8_0, 639,442,784 bytes. Download metadata records
the tested revision and SHA-256 beside the local model file.
Existing saved selections are preserved; the larger formatter remains optional.
Whisper weights are unchanged. No training or Python runtime is needed.

The small model uses its trained `text: …\nout:` completion protocol, greedy
decoding and a 4,096-token context. It does not receive the larger model's JSON
schema or chat prompt. Clear enumerations, task markers, withdrawn final items,
spoken paragraph commands and email layout use code. The model handles cleanup
where a language decision remains. Explicit answers and quoted words are preserved.

Both servers preload when the CLI starts, without microphone capture. On this
M4, one startup check loaded them in 1.24 seconds; subsequent server reuse took
less than 1 ms. Loading remains asynchronous, so a dictation started immediately
after launch may still await it. Idle memory release, cancellation and shutdown
continue to free the servers; startup preload is disabled when Keep models warm
is Off.

Sixteen fictional German quality cases passed on the current path. Representative
warm formatting times below exclude ASR, startup, clipboard and insertion. The
earlier column was measured on the previous 4B path with the same fictional text.
This compares complete formatting paths, including code routing and model changes,
not just inference engines.

| Case | Previous 4B path | Current path |
| --- | ---: | ---: |
| Abandoned final list item | 3,135 ms, incorrect fourth item | < 1 ms, three items |
| Corrected email and repaired paragraph command | 3,025 ms, corrections retained | 191 ms, corrected email |
| Correction, repeated word and empty ending | 1,969 ms | 126 ms |
| Amounts and negation | 2,232 ms | 164 ms |
| Quoted filler and identifiers | 1,671 ms | 122 ms |

These are small local regression checks, not a general accuracy or latency claim.
The publisher reports lower quality outside English. Other short fine-tunes were
also tested: S1-mini-de-v3 changed 87 to 78 and 31 to 130 in a German numeric case;
the Mavery Lehrling 0.8B Q8 MLX candidate lost the minutes from a dictated time.
Neither was selected. Raw transcripts, audio and previous results stay available.

Run `npm run verify:formatting` against the selected formatter, or add
`-- --model path/to/formatter.gguf` to check a candidate without changing settings.
Reports stay in ignored `formatting-qa/` storage.

### Context and language follow-up

The current regression set includes the seven cleanup languages, contextual
paragraph mentions, meaningful
uncertainty, compound task objects, empty list endings and lists between prose
paragraphs, including packing items with self-corrections. German and English
synthetic audio also exercise automatic language detection, persistence of the
detected language in transcription checkpoints, and formatting with that language.
Automatic language detection adds recognition work compared with a fixed language;
preloading removes model startup, not this per-recording detection cost.

A confirmed recognition error remains open: one German dictation of 31 percent
is recognized as 130 percent. Both installed Whisper variants reproduced it,
including changed beam settings, neutral context prompts and audio filtering or
speed changes. No numeric replacement rule was added. Formatter-only number
tests do not prove that a number was recognized correctly from real audio.

## Historical same-model runtime study

The study below kept the selected speech and formatter models unchanged. It
changed how the existing weights ran and avoided redundant formatting requests.

The timing tables below document the runtime study before the subsequent
formatting-quality correction. Automatic mode had wrongly skipped real speech
with filler endings and natural to-do requests. Current Auto detection is more
conservative, the prompt explicitly cleans speech and selects prose/list/checklist
structure, and empty closing phrases have a targeted cleanup. These tables are
historical results, not latency promises for the corrected pipeline. Verify the
current quality with `npm run verify:formatting` and remeasure as needed.

## Measurements

Measured locally on an Apple M4 with 16 GB unified memory on 20 October 2026.
The runtime was llama.cpp build 10470 (`34af94cd9`), with Metal acceleration.
Speech used the selected Whisper large-v3-turbo F16 weights; formatting used
`Qwen3.5-4B-dictation-v3-MTP-Q4_K_M.gguf`.

These are small, synthetic German benchmarks on an interactive workstation,
not a guarantee for every recording. The controlled formatter and audio-pipeline
comparisons use identical model files, prompts and greedy sampling. Exploratory
MTP/thread trials kept production sampling at 0.2. The optional 4B formatter uses
temperature 0.2; the new small model uses greedy decoding. Model startup,
microphone capture and text delivery are reported separately
or excluded; the audio pipeline below starts with an already stopped WAV file.

### Formatter runtime in isolation

Three repetitions per case, median milliseconds. Formatting is forced in both
variants so the paragraph optimization does not inflate the runtime comparison.

| Synthetic case | Previous runtime | Prompt lookup | Change |
| --- | ---: | ---: | ---: |
| Short correction | 1,735 | 1,663 | 4% faster |
| Amounts and negation | 1,759 | 1,936 | 10% slower |
| Correction and paragraphs | 3,004 | 2,558 | 15% faster |
| List | 1,407 | 1,377 | 2% faster |
| Long message | 11,107 | 9,376 | 16% faster |

All semantic checks passed. All optimized texts in this fixed comparison matched
a baseline text exactly. Checks cover final corrections, negations, amounts,
identifiers, Markdown lists, paragraphs and preserved facts. This does not prove
equivalent quality for arbitrary inputs. Prompt lookup has overhead when little
of the original wording survives, as the amount-conversion case demonstrates.

### Audio to formatted text

A separate approximately 12-second synthetic dictation includes a correction,
a spoken paragraph break and a clean second paragraph. Both pipelines use the
same Auto setting, audio and model files. The previous formatter implementation
was compared directly with the updated one, with three runs per variant.

Previous total: **4.08–4.14 seconds**. Updated total: **2.00–2.52 seconds**.
The final text was identical in all six runs. Whisper took about 1.2 seconds in
both pipelines. The first optimized formatting request took 1.3 seconds; repeated
requests for the same paragraph took about 0.8 seconds. Exact repeated prompts
can benefit from runtime caching, so the faster end of this range should not be
assumed for a different dictation.

The checked-in audio benchmark independently reproduced **4.16–4.19 seconds**
versus **2.00–2.43 seconds**, again with identical final text in all six runs.

## Historical runtime changes

- On Apple Silicon, a compatible llama-server uses `ngram-simple` prompt lookup
  for dictation: lookup length 3, draft length 16. It proposes continuations from
  the supplied text. The selected formatter model verifies the proposals; no
  additional draft model is installed.
- The installed binary is checked once for the required flags. Older binaries,
  failed capability probes and other platforms retain normal server arguments.
- The 4B pipeline prewarmed one stable 16,384-token formatter context. Previously a
  transcript longer than 6,000 characters discarded the warm 8,192-token server
  and loaded the same weights again. Short dictations also used to shrink an
  existing large context. The current 0.6B formatter instead reserves 4,096
  tokens at startup; the optional 4B formatter retains 16,384.
- That Auto pipeline kept clean message paragraphs verbatim while edited
  paragraphs went through the model. Previously one edited paragraph caused
  every paragraph to be regenerated. The current pipeline also preserves mixed
  prose/list sections and handles clear layout in code. Always mode still
  requests semantic cleanup. Audio is transcribed only after capture stops.

## Alternatives measured

**MLX Whisper:** the selected GGML F16 tensors were repacked locally into MLX
weights, with FP16 runtime casting following the official converter. No model
variant or quantization was substituted. Normalized transcript text matched
whisper.cpp on both synthetic files. On warm requests, approximately 12 seconds
of audio took 1.10 seconds versus 1.22–1.23 seconds with whisper.cpp; 40 seconds
took about 2.45 versus 2.73 seconds. The first short MLX request took 2.66 seconds,
plus about 0.14 seconds loading, versus 1.23 plus 0.79 seconds for whisper.cpp.
This modest warm gain did not justify an extra Python service and a slower first
request. The shipped app keeps its existing Metal runtime.

**MTP:** the existing formatter includes an MTP head. Enabling three draft tokens
was slower here: around 1.82 versus 1.71 seconds for the short case and 11.7 versus
11.1 seconds for the long case. It is not enabled by default.

**Other settings:** explicit four-thread/Flash Attention settings did not improve
the installed runtime defaults. Larger 32-token drafts regressed. Smaller
eight-token drafts helped the short case but lost most of the long-text gain.
More frequent context checkpoints and smaller microbatches enabled some prefix
reuse but did not establish a better overall result. Alternative n-gram lookup
and experimental backend sampling also failed to beat the selected profile
across the fixed cases.

**Shorter Whisper audio context:** faster on the 12-second sample, but introduced
a duplicated sentence or a language switch. This change was rejected.

## Reproduce

```sh
npm run benchmark:runtime
npm run benchmark:runtime -- --audio-only
```

The first command compares the formatter runtimes with the currently selected
formatter weights. The second runs the synthetic stopped-audio pipeline and
requires FFmpeg and the macOS German Anna voice. Add `--audio` to run both.
The audio baseline recreates the previous Auto routing, which sent every
paragraph through the formatter when any section required editing. It does not
use another model or a different prompt.

Reports, fictional audio and full synthetic outputs go to a new ignored
`runtime-qa/<timestamp>/` directory inside `SYLLOOM_HOME`. Neither benchmark
records the microphone, inserts text, touches the clipboard or reads recordings.
Review the quality results together with latency. Results change with hardware,
runtime versions, memory pressure, input length and how much text needs editing.

Primary references: [llama.cpp speculative decoding](https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md),
[llama-server options](https://github.com/ggml-org/llama.cpp/tree/master/tools/server),
[Apple MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper),
[MLX weight conversion](https://github.com/ml-explore/mlx-examples/blob/main/whisper/convert.py),
[formatter model card](https://huggingface.co/justusraw/Qwen3.5-4B-Parakeet-formatter),
[Metal MTP reports](https://github.com/ggml-org/llama.cpp/issues/23752).
