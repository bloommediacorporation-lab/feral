/**
 * #20: minimal i18n layer for the RO/EN audience.
 *
 * Not a framework — a typed dictionary + a hook. The `language` preference
 * already exists in the UI store (Settings → General); this finally makes it
 * do something. Migration is incremental: components move to `useT()` as
 * they're touched, with the chat surface (highest visibility) first.
 *
 * To add a string: add the key to BOTH `en` and `ro` below — the `Strings`
 * type makes a missing `ro` key a compile error.
 */

import { useCallback } from 'react';
import { useUI } from '@/stores/ui';

const en = {
  // Chat input
  'chat.placeholder': 'Ask anything…',
  'chat.placeholder.agent': 'Ask Cinderpaw…',
  'chat.placeholder.noModel': 'Load a model or add a cloud key to start chatting',
  'chat.noModelHint': 'No model loaded. Open Models to download one, or add a cloud key in Settings.',
  // Spoken by the product, not the model — there is no model to speak. See
  // ChatInput.noModelReply.
  'chat.noModel.reply':
    "I need a model before I can do that. I can run a small one locally on this machine, which works offline, or use an API key if you already have one.",
  'chat.noModel.download': 'Download a model',
  // Model picker trigger when nothing is pinned. Choosing by hand is an
  // override now, not a prerequisite — Brain routes per turn.
  'model.automatic': 'Automatic',
  'model.add': 'Add a model',
  'chat.noModel.addKey': 'Add a key',
  // Shown when automatic model selection failed and the default was used.
  // A fallback is allowed; a hidden one is not.
  'chat.routed.fallback': 'I used your default model. Automatic model choice was unavailable.',
  'chat.routed.why': 'Why?',
  'chat.stop': 'Stop',
  'chat.send': 'Send',
  // Empty states
  'empty.noModel.title': 'No model selected',
  'empty.noModel.body': 'Load a local model or configure a cloud key to start chatting.',
  'empty.noModel.openModels': 'Open Models',
  'empty.noModel.cloudKeys': 'Cloud Keys',
  'empty.greeting.1': 'What can I help you with?',
  'empty.greeting.2': "What's on your mind?",
  'empty.greeting.3': 'How can I assist you today?',
  'empty.greeting.4': 'What would you like to explore?',
  'empty.greeting.5': 'What can I help you build?',
  'empty.welcomeBack': 'Welcome back to',
  // Home: the time of day, then the one question. Fixed, not rotating — a
  // greeting that changes every four seconds is a screensaver, not a greeting.
  'home.morning': 'Good morning',
  'home.afternoon': 'Good afternoon',
  'home.evening': 'Good evening',
  'home.ask': 'What can I help you with?',
  // The four intents. A statement about what the product is, so they are fixed
  // and in this order — they are not suggestions and they are not shuffled.
  'home.intent.research': 'Research',
  'home.intent.create': 'Create',
  'home.intent.analyze': 'Analyze',
  'home.intent.automate': 'Automate',
  // Truncated-response banner
  'chat.truncated.title': 'Response truncated.',
  'chat.truncated.body': 'The model hit its token limit before finishing',
  'chat.truncated.hint.pre': 'Increase',
  'chat.truncated.hint.post': 'in Settings for longer replies.',
  // Voice messages
  'voice.permissionDenied': 'Microphone access denied. Enable it to record voice messages.',
  'voice.unsupported': 'Voice recording is not available on this device.',
  'voice.modelDownloading': 'Downloading the voice model. Try again in a moment.',
  'voice.emptyTranscript': "Couldn't understand the recording. Try again.",
  'voice.transcribing': 'Transcribing…',
  'voice.cloudFailed': 'Cloud transcription failed. Check your connection or key.',
  'voice.keySaveFailed': "Couldn't save the API key. Try again.",
  'voice.provider.title': 'Choose voice transcription',
  'voice.provider.subtitle': 'How should your voice messages be turned into text? You can change this later (long-press the mic).',
  'voice.provider.local.title': 'On your device (Whisper)',
  'voice.provider.local.desc': 'Private · 100% offline · free. Uses ~0.5 GB RAM and is less accurate, especially for non-English.',
  'voice.provider.cloud.title': 'Cloud (Groq · whisper-large-v3)',
  'voice.provider.cloud.desc': 'Much more accurate · free tier. ⚠️ Your audio leaves your device.',
  'voice.provider.cloud.keyPlaceholder': 'Paste your Groq API key',
  'voice.provider.cloud.getKey': 'Get a free Groq key →',
  'voice.provider.cloud.keySet': '✓ Groq key saved.',
  'voice.provider.confirm': 'Use this',
  // Voice call
  'call.aria': 'Start a voice call',
  'call.title': 'Voice call',
  'call.disclosure': 'Before the microphone opens, this is what will handle the call:',
  // These name the ENGINE, not the hardware. "Your voice → Groq" read as if Groq
  // were the microphone; the direction of the conversion is what makes it clear.
  'call.stt': 'Speech → text',
  'call.tts': 'Text → speech',
  'call.mic': 'Microphone',
  'call.tools': 'Tools',
  'call.toolsOff': 'none in this call, it answers from what it knows',
  'call.micDefault': 'System default',
  'call.onDevice': 'on device',
  'call.leavesDevice': 'leaves device',
  'call.answer': 'Call',
  'call.setUpVoice': 'Choose a voice',
  // Said BEFORE the button is pressed. The old path booted Node, a LiveKit
  // server and an npm install first, then failed with advice about checking
  // the network — on a machine whose network was fine.
  'call.noEngine':
    'Cinderpaw has no voice to speak with yet. This version needs one you choose: a voice that runs on your machine, or a cloud voice with a key. Pick one and the call will work.',
  'call.listening': 'Listening…',
  'call.thinking': 'Thinking…',
  'call.speaking': 'Speaking…',
  'call.interrupt': 'Interrupt',
  'call.hangUp': 'Hang up',
  'call.turnFailed': "That turn didn't go through. Still listening.",
  'call.prompt': "What's on your mind?",
  'call.voice': 'Voice',
  'call.voiceDefault': "Vendor's default voice",
  'call.voicesLoading': 'Loading voices…',
  // Not "paste a voice id". A person who came to make a phone call has no
  // idea what a voice id is, and no way to find one: the list that would have
  // told them is the thing that just failed. Say what will be used instead,
  // and say it as a fact rather than as a problem they have to solve.
  'call.voicesUsingDefault': 'Voice list unavailable, using',
  'call.voicesNeedKey': 'Add this engine’s key in Settings to choose a voice.',
  'call.voiceIdPlaceholder': 'Voice id',
  'call.voicesAvailable': 'available',
  'call.voiceMore': 'Showing the most relevant. Paste any voice id to use another:',
  'call.tooShort': 'That was too short to transcribe. Say a bit more.',
  'call.micSilent': 'No microphone signal detected. Check your input device or mute setting.',
  'call.noReply': 'Nothing came back to say. Is a model selected?',
  'call.replyFailed': 'The reply failed. Open the chat panel to see why.',
  'call.replyTimeout': 'It went quiet for a minute. Still listening.',
  // Spoken aloud, not shown — the line the call says while the model works.
  // Deliberately says nothing about what it is doing: it fires on every slow
  // turn, and a promise to "look that up" would be a lie on most of them.
  'call.thinkingAloud': 'One moment.',
  // Said at twelve-second intervals while a turn runs long. Deliberately vaguer
  // as they go: by the third one, promising it is nearly done would be a lie,
  // and the honest version is the one that keeps the line trustworthy.
  'call.stillWorking': 'Still working on it.',
  'call.stillWorkingLong': "This one's taking a while, still going.",
  'call.almostThere': "Still here, still on it.",
  'call.replyStopped': 'That reply was cut off. Say it again.',
  'call.voiceMissing': 'This engine has no voice downloaded yet. Get one from “Change voice engine”.',
  'call.keyNeeded': 'This voice engine needs an API key. It goes straight to your OS keychain.',
  // Names the vendor, because the field used to say Google whichever vendor was
  // picked, and a key pasted under the wrong name is worse than one refused.
  'call.keyNeededFor': 'No {provider} key stored. Paste one below and it goes straight to your OS keychain.',
  'call.keyPlaceholder': 'Paste the API key',
  'call.keySave': 'Save',
  'call.chat': 'Chat',
  'call.chatClose': 'Close chat',
  'call.chatPlaceholder': 'Type instead of speaking…',
  // Speech to speech — one model hears you and answers in its own voice, so
  // none of the pipeline's three engines is involved.
  'call.mode': 'Call mode',
  'call.modePipeline': 'Transcribe → answer → speak',
  'call.modeLive': 'Speech to speech (previous)',
  'call.modeLiveKit': 'Speech to speech',
  'call.provider': 'Voice provider',
  'call.providerNoKey': 'no key',
  'call.engineUnset': 'not chosen yet',
  'call.providerNoneShort': 'Echo (no key)',
  'call.providerNone': '{provider} has no key stored, so this call will echo you back instead of answering. Add one in Settings → Cloud Keys.',
  'call.liveEngine': 'Gemini Live',
  'call.liveNoKey': 'No Google API key stored. The same AI Studio key the chat side uses. Paste it below.',
  'call.liveClosed': 'Disconnected. Press call to reconnect.',
  'call.liveConnecting': 'Connecting…',
  // The three stages of getting into a call, named rather than hidden behind
  // one spinner: fifteen seconds of "connecting" is indistinguishable from a
  // hang, and these are the waits that are actually happening.
  'call.stage.starting': 'Starting the voice engine…',
  'call.stage.joining': 'Joining the call…',
  'call.stage.mic': 'Opening the microphone…',
  'call.reconnecting': 'Connection lost. Reconnecting…',
  // The work panel — what Cinderpaw is doing while the call waits.
  'call.toolSearching': 'searching…',
  'call.toolDone': 'done',
  'call.toolFailed': 'failed',
  'call.toolsRunning': 'tasks running',
  'call.artifacts': 'Sources',
  'call.artifactsClose': 'Close sources',
  'call.artifactsClear': 'Clear',
  'call.artifactsEmpty': 'Nothing looked up yet. Searches, files and memory lookups land here, with their links.',
  // Voice engine picker (first call)
  'engine.title': 'Choose the voice that answers you',
  'engine.subtitle': 'On-device engines keep every spoken reply on this machine. Hosted ones need your own key. You can change this later.',
  'engine.soon': 'not in this build yet',
  'engine.keySaved': 'Key saved, type a new one to replace it',
  'engine.baseUrlPlaceholder': 'Base URL (Azure: https://<region>.tts.speech.microsoft.com)',
  'engine.modelPlaceholder': 'Model or voice name (optional)',
  'engine.getKey': 'Get a key →',
  'engine.change': 'Change voice engine',
  'engine.keyPresent': '✓ A key is already saved for this engine',
  'engine.keyRequired': 'This engine needs a key before it can speak',
  'engine.keyForget': 'Remove it',
  'engine.save': 'Save',
  'engine.cancel': 'Cancel',
  'engine.voicePlaceholder': 'Voice',
  'engine.downloadVoice': 'Download voice (~60 MB)',
  'engine.downloading': 'Downloading the voice…',
  // Conversation list headings. Deliberately the same words every other app
  // uses — this is a list someone scans, not a place to be inventive.
  'chats.group.today': 'Today',
  'chats.group.yesterday': 'Yesterday',
  'chats.group.last7': 'Previous 7 days',
  'chats.group.last30': 'Previous 30 days',
  // For conversations saved before a timestamp was recorded. Says what is
  // true — we do not know when — rather than guessing a date for them.
  'chats.group.undated': 'Older',
} as const;

type Strings = Record<keyof typeof en, string>;

const ro: Strings = {
  'chat.placeholder': 'Întreabă orice…',
  'chat.placeholder.agent': 'Întreabă Cinderpaw…',
  'chat.placeholder.noModel': 'Încarcă un model sau adaugă o cheie cloud ca să începi',
  'chat.noModelHint': 'Niciun model încărcat. Deschide Models ca să descarci unul, sau adaugă o cheie cloud în Settings.',
  'chat.noModel.reply':
    'Îmi trebuie un model ca să pot face asta. Pot rula unul mic direct pe calculatorul tău, merge și fără internet, sau pot folosi o cheie API, dacă ai deja una.',
  'chat.noModel.download': 'Descarcă un model',
  'model.automatic': 'Automat',
  'model.add': 'Adaugă un model',
  'chat.noModel.addKey': 'Adaugă o cheie',
  'chat.routed.fallback': 'Am folosit modelul tău implicit. Alegerea automată n-a fost disponibilă.',
  'chat.routed.why': 'De ce?',
  'chat.stop': 'Oprește',
  'chat.send': 'Trimite',
  'empty.noModel.title': 'Niciun model selectat',
  'empty.noModel.body': 'Încarcă un model local sau configurează o cheie cloud ca să începi conversația.',
  'empty.noModel.openModels': 'Deschide Models',
  'empty.noModel.cloudKeys': 'Chei cloud',
  'empty.greeting.1': 'Cu ce te pot ajuta?',
  'empty.greeting.2': 'La ce te gândești?',
  'empty.greeting.3': 'Cum te pot ajuta azi?',
  'empty.greeting.4': 'Ce ai vrea să explorezi?',
  'empty.greeting.5': 'Ce construim împreună?',
  'home.morning': 'Bună dimineața',
  'home.afternoon': 'Bună ziua',
  'home.evening': 'Bună seara',
  'home.ask': 'Cu ce te pot ajuta?',
  'home.intent.research': 'Caută',
  'home.intent.create': 'Creează',
  'home.intent.analyze': 'Analizează',
  'home.intent.automate': 'Automatizează',
  'empty.welcomeBack': 'Bine ai revenit la',
  'chat.truncated.title': 'Răspuns trunchiat.',
  'chat.truncated.body': 'Modelul a atins limita de tokeni înainte să termine',
  'chat.truncated.hint.pre': 'Mărește',
  'chat.truncated.hint.post': 'în Settings pentru răspunsuri mai lungi.',
  'voice.permissionDenied': 'Acces la microfon refuzat. Activează-l ca să înregistrezi mesaje vocale.',
  'voice.unsupported': 'Înregistrarea vocală nu este disponibilă pe acest dispozitiv.',
  'voice.modelDownloading': 'Se descarcă modelul vocal. Încearcă din nou într-o clipă.',
  'voice.emptyTranscript': 'Nu am putut înțelege înregistrarea. Mai încearcă o dată.',
  'voice.transcribing': 'Transcriere…',
  'voice.cloudFailed': 'Transcrierea în cloud a eșuat. Verifică conexiunea sau cheia.',
  'voice.keySaveFailed': 'Nu am putut salva cheia API. Mai încearcă.',
  'voice.provider.title': 'Alege transcrierea vocală',
  'voice.provider.subtitle': 'Cum transformăm mesajele tale vocale în text? Poți schimba mai târziu (ține apăsat pe microfon).',
  'voice.provider.local.title': 'Pe dispozitivul tău (Whisper)',
  'voice.provider.local.desc': 'Privat · 100% offline · gratis. Folosește ~0.5 GB RAM și e mai puțin precis, mai ales non-engleză.',
  'voice.provider.cloud.title': 'Cloud (Groq · whisper-large-v3)',
  'voice.provider.cloud.desc': 'Mult mai precis · free tier. ⚠️ Audio-ul tău părăsește dispozitivul.',
  'voice.provider.cloud.keyPlaceholder': 'Lipește cheia ta API Groq',
  'voice.provider.cloud.getKey': 'Ia o cheie Groq gratis →',
  'voice.provider.cloud.keySet': '✓ Cheia Groq salvată.',
  'voice.provider.confirm': 'Folosește asta',
  'call.aria': 'Începe un apel vocal',
  'call.title': 'Apel vocal',
  'call.disclosure': 'Înainte să se deschidă microfonul, astea se ocupă de apel:',
  'call.stt': 'Vorbire → text',
  'call.tts': 'Text → vorbire',
  'call.mic': 'Microfon',
  'call.tools': 'Unelte',
  'call.toolsOff': 'niciuna în acest apel, răspunde din ce știe',
  'call.micDefault': 'Implicit din sistem',
  'call.onDevice': 'pe dispozitiv',
  'call.leavesDevice': 'pleacă de pe dispozitiv',
  'call.answer': 'Sună',
  'call.setUpVoice': 'Alege o voce',
  'call.noEngine':
    'Cinderpaw nu are încă o voce cu care să vorbească. Versiunea aceasta are nevoie de una aleasă de tine: o voce care rulează pe calculatorul tău, sau o voce din cloud cu o cheie. Alege una și apelul va funcționa.',
  'call.listening': 'Ascult…',
  'call.thinking': 'Mă gândesc…',
  'call.speaking': 'Vorbesc…',
  'call.interrupt': 'Întrerupe',
  'call.hangUp': 'Închide',
  'call.turnFailed': 'Tura asta nu a mers. Încă ascult.',
  'call.prompt': 'La ce te gândești?',
  'call.voice': 'Voce',
  'call.voiceDefault': 'Vocea implicită a furnizorului',
  'call.voicesLoading': 'Se încarcă vocile…',
  'call.voiceIdPlaceholder': 'Id de voce',
  'call.voicesUsingDefault': 'Lista de voci nu e disponibilă, folosesc',
  'call.voicesNeedKey': 'Adaugă cheia motorului în Setări ca să poți alege vocea.',
  'call.voicesAvailable': 'disponibile',
  'call.voiceMore': 'Arăt cele mai relevante. Lipește orice id de voce pentru altele:',
  'call.tooShort': 'A fost prea scurt ca să pot transcrie. Mai zi un pic.',
  'call.micSilent': 'Microfonul nu trimite semnal. Verifică dispozitivul de intrare sau dacă este pe mut.',
  'call.noReply': 'N-a venit nimic de spus. Ai un model selectat?',
  'call.replyFailed': 'Răspunsul a eșuat. Deschide panoul de chat ca să vezi de ce.',
  'call.replyTimeout': 'A rămas mut un minut. Încă ascult.',
  'call.thinkingAloud': 'O secundă.',
  'call.stillWorking': 'Încă lucrez la asta.',
  'call.stillWorkingLong': 'Durează un pic mai mult, încă lucrez.',
  'call.almostThere': 'Sunt aici, încă mă ocup.',
  'call.replyStopped': 'Răspunsul a fost întrerupt. Mai zi o dată.',
  'call.voiceMissing': 'Motorul ăsta n-are încă nicio voce descărcată. Ia una din „Schimbă motorul de voce”.',
  'call.keyNeeded': 'Motorul ăsta de voce are nevoie de o cheie API. Merge direct în keychain-ul sistemului.',
  'call.keyNeededFor': 'Nu e salvată nicio cheie {provider}. Lipește una mai jos, merge direct în keychain-ul sistemului.',
  'call.keyPlaceholder': 'Lipește cheia API',
  'call.keySave': 'Salvează',
  'call.chat': 'Chat',
  'call.chatClose': 'Închide chatul',
  'call.chatPlaceholder': 'Scrie în loc să vorbești…',
  'call.mode': 'Tipul apelului',
  'call.modePipeline': 'Transcrie → răspunde → vorbește',
  'call.modeLive': 'Vorbire la vorbire (vechi)',
  'call.modeLiveKit': 'Vorbire la vorbire',
  'call.provider': 'Furnizor de voce',
  'call.providerNoKey': 'fără cheie',
  'call.engineUnset': 'nealeas încă',
  'call.providerNoneShort': 'Ecou (fără cheie)',
  'call.providerNone': '{provider} nu are o cheie salvată, deci apelul îți va întoarce ecoul în loc să-ți răspundă. Adaugă una în Setări → Chei cloud.',
  'call.liveEngine': 'Gemini Live',
  'call.liveNoKey': 'Nu e salvată nicio cheie Google. E aceeași cheie AI Studio pe care o folosește și chatul. Lipește-o mai jos.',
  'call.liveClosed': 'Deconectat. Apasă pe apel ca să reconectezi.',
  'call.liveConnecting': 'Se conectează…',
  'call.stage.starting': 'Pornește motorul vocal…',
  'call.stage.joining': 'Intră în apel…',
  'call.stage.mic': 'Deschide microfonul…',
  'call.reconnecting': 'Conexiune pierdută, se reconectează…',
  'call.toolSearching': 'caută…',
  'call.toolDone': 'gata',
  'call.toolFailed': 'a eșuat',
  'call.toolsRunning': 'sarcini în lucru',
  'call.artifacts': 'Surse',
  'call.artifactsClose': 'Închide sursele',
  'call.artifactsClear': 'Golește',
  'call.artifactsEmpty': 'Încă n-a căutat nimic. Căutările, fișierele și memoria ajung aici, cu linkurile lor.',
  'engine.title': 'Alege vocea care îți răspunde',
  'engine.subtitle': 'Motoarele locale țin fiecare replică pe mașina asta. Cele hostate cer cheia ta. Poți schimba mai târziu.',
  'engine.soon': 'încă nu e în build',
  'engine.keySaved': 'Cheie salvată, scrie una nouă ca s-o înlocuiești',
  'engine.baseUrlPlaceholder': 'Base URL (Azure: https://<regiune>.tts.speech.microsoft.com)',
  'engine.modelPlaceholder': 'Nume de model sau voce (opțional)',
  'engine.getKey': 'Ia o cheie →',
  'engine.change': 'Schimbă motorul de voce',
  'engine.keyPresent': '✓ Există deja o cheie salvată pentru motorul ăsta',
  'engine.keyRequired': 'Motorul ăsta are nevoie de o cheie ca să poată vorbi',
  'engine.keyForget': 'Șterge-o',
  'engine.save': 'Salvează',
  'engine.cancel': 'Anulează',
  'engine.voicePlaceholder': 'Voce',
  'engine.downloadVoice': 'Descarcă vocea (~60 MB)',
  'engine.downloading': 'Se descarcă vocea…',
  'chats.group.today': 'Azi',
  'chats.group.yesterday': 'Ieri',
  'chats.group.last7': 'Ultimele 7 zile',
  'chats.group.last30': 'Ultimele 30 de zile',
  'chats.group.undated': 'Mai vechi',
};

const DICTS = { en, ro } as const;

export type StringKey = keyof typeof en;

/** Non-reactive lookup for code outside React (stores, callbacks). */
export function t(key: StringKey): string {
  const lang = useUI.getState().language;
  return DICTS[lang]?.[key] ?? en[key];
}

/** Reactive hook — re-renders the component when the language changes. */
export function useT(): (key: StringKey) => string {
  const lang = useUI((s) => s.language);
  return useCallback((key: StringKey) => DICTS[lang]?.[key] ?? en[key], [lang]);
}
