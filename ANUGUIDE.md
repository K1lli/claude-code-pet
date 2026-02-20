# Anu — Täydellinen dokumentaatio

Anu on Electron-pohjainen työpöytäkumppani Windowsille. Hän reagoi siihen mitä teet koneella — mitä ohjelmaa käytät, miten kauan olet paikalla, vuorokaudenaikaan, musiikkiin, WhatsApp-viesteihin ja paljon muuhun.

---

## Sisältö

1. [Arkkitehtuuri](#arkkitehtuuri)
2. [Ohjelmien tunnistus](#ohjelmien-tunnistus)
3. [Kaikki tilat ja ilmeet](#kaikki-tilat-ja-ilmeet)
4. [Kaikki reaktiot ja tapahtumat](#kaikki-reaktiot-ja-tapahtumat)
5. [Vuorovaikutus Anun kanssa](#vuorovaikutus-anun-kanssa)
6. [Rakkaustasot](#rakkaustasot)
7. [Kaikki Anun sanomiset](#kaikki-anun-sanomiset)
8. [Ajastimet ja rutiinit](#ajastimet-ja-rutiinit)
9. [Ulkoiset integraatiot](#ulkoiset-integraatiot)
10. [Radial-valikko](#radial-valikko)
11. [Konfiguraatio](#konfiguraatio)

---

## Arkkitehtuuri

```
main.js          Electron main process — watchers, IPC, viestijono
pet.html         Kaikki visuaalisuus — ilmeet, partikkelit, puhekuplat
config.js        Asetukset — tallennetaan AppData/Roaming/claude-code-pet/config.json
hook.js          Claude Code hook — tunnistaa VS Code -tapahtumat
watchers/
  idle-detector.js    Tunnistaa kun et tee mitään (60s threshold)
  window-tracker.js   Tunnistaa aktiivisen ohjelman (5s pollaus)
  system-monitor.js   CPU-käyttö
  pomodoro.js         Pomodoro-ajastin
  git-watcher.js      Git-muutokset
  build-watcher.js    Build-prosessit
  notifications.js    WhatsApp-ilmoitukset (Windows 10/11)
  spotify.js          Spotify-integraatio
  weather.js          Säätiedot
assets/
  skins/girlfriend/   27 PNG-expressiota (neutral, happy, thinking, ...)
  sounds/             Ääniefektit (howler.js)
```

**IPC-viestintä:** main.js → pet.html yksisuuntaisesti `win.webContents.send()` kautta. Renderer vastaa `ipcRenderer.send()` kautta (love-meter-save, pet-interaction jne.)

**Viestijonon prioriteetti:** WatcherManager yhdistää watchers-tilat prioriteettijärjestyksessä. Korkein prioriteetti voittaa:
1. Build/Git (korkein)
2. System monitor (CPU)
3. Pomodoro
4. Window tracker (ohjelma)
5. Idle detector (alin)

---

## Ohjelmien tunnistus

WindowTracker tarkistaa aktiivisen ikkunan prosessin nimen 5 sekunnin välein PowerShellin kautta.

### Tunnistetut ohjelmat → tila

| Ohjelma (prosessi) | Tila | Ilme |
|-------------------|------|------|
| `Code.exe` | `coding` | thinking |
| `WindowsTerminal.exe` | `coding` | thinking |
| `powershell.exe` | `coding` | thinking |
| `cmd.exe` | `coding` | thinking |
| `chrome.exe` | `searching` | silly |
| `firefox.exe` | `searching` | silly |
| `msedge.exe` | `searching` | silly |
| `opera.exe` | `searching` | silly |
| `brave.exe` | `searching` | silly |
| `Spotify.exe` | `idle-dancing` | vibe |
| `vlc.exe` | `idle-dancing` | vibe |
| `wmplayer.exe` | `idle-dancing` | vibe |
| `slack.exe` | `reading` | happy |
| `Discord.exe` | `reading` | happy |
| `Telegram.exe` | `reading` | happy |
| `WhatsApp.exe` | `idle` | happy |
| `Teams.exe` | `meeting` | shy |
| `ms-teams.exe` | `meeting` | shy |
| `Zoom.exe` | `meeting` | shy |
| `WebexMeetings.exe` | `meeting` | shy |
| `notepad.exe` | `writing` | thinking |
| `Notepad++.exe` | `writing` | thinking |
| `WINWORD.EXE` | `writing` | thinking |
| `EXCEL.EXE` | `reading` | happy |
| `POWERPNT.EXE` | `writing` | thinking |
| `Obsidian.exe` | `reading` | happy |
| `notion.exe` | `reading` | happy |
| `onenote.exe` | `reading` | happy |
| `explorer.exe` | `file-browsing` | confused |
| `Taskmgr.exe` | `system-panic` | scared |
| `steam.exe` | `gaming` | vibe |
| `EpicGamesLauncher.exe` | `gaming` | vibe |
| `Battle.net.exe` | `gaming` | vibe |
| **Muu ohjelma** | *(ei muutosta)* | edellinen jää |

### Reaktiot tilan vaihtuessa

| Tila (uusi) | Reaktio |
|-------------|---------|
| `file-browsing` | 50% mahdollisuus: "Etsitäänkö jotain? 🗂️" |
| `system-panic` | Hikilaukaus + "Tehtävienhallinta?! Mikä räjähti?! 😱" |
| `writing` | 50% mahdollisuus: "Kirjoitetaan jotain tärkeää? ✍️" |
| `meeting` | "Palaveri alkaa! Muista hymyillä 😊" |
| `gaming` | Sydämet (3) + "Pelataanko! 🎮 Mäkin haluun! 🥺" |
| `error → muu` | Sydämet (5) + sparklet + "Näitkö? Tiesin et sä korjaat sen! 💖🎉" |
| `testing → success` | Sydämet (7) + konfetit (12) + sparklet (6) + "HYVÄ POIKA! 💖🎉" |
| `success / deploying` | Sydämet (4) + 1s viiveellä |

---

## Kaikki tilat ja ilmeet

### 27 saatavilla olevaa expressiota

```
neutral          happy            focused (→ thinking)
thinking         determined       surprised
angry            annoyed          worried
scared           sad              crying
sleepy           smug             silly
embarrassed      shy              confused
proud            vibe             meditating
look_left        lovestruck_heart_eyes    kissing
hopeful_star_eyes    laughing     winking_blep
```

> Huom: `focused` renderöidään `thinking`-kuvaksi (focused.png näyttää liian vihaiselta)

### Täydellinen tila → ilme -kartta (43+ tilaa)

| Tila | Ilme | Milloin |
|------|------|---------|
| `idle` | happy | Oletustila, ei aktiivisuutta |
| `idle-vibing` | vibe | Idle-kierros |
| `idle-coffee` | vibe | Idle-kierros |
| `idle-stargazing` | happy | Idle-kierros |
| `idle-sleepy` | sleepy | Idle-kierros tai klo 22–05 |
| `idle-dancing` | vibe | Spotify/media päällä |
| `idle-rainbow` | vibe | Harvinainen idle-variantti |
| `idle-butterfly` | happy | Harvinainen idle-variantti |
| `idle-juggling` | silly | Harvinainen idle-variantti |
| `idle-stretching` | proud | Harvinainen idle-variantti |
| `idle-meditation` | meditating | Harvinainen idle-variantti |
| `coding` | thinking | VS Code / terminal |
| `coding-flow` | happy | Harvinainen variantti (coding) |
| `coding-hacking` | thinking | Harvinainen variantti (coding) |
| `thinking` | thinking | Oletustyöskentely |
| `thinking-cooking` | thinking | Variantti |
| `thinking-creating` | thinking | Variantti |
| `thinking-processing` | thinking | Variantti |
| `thinking-action` | thinking | Variantti |
| `thinking-eureka` | surprised | Variantti |
| `thinking-galaxy` | smug | Variantti |
| `thinking-magical` | smug | Variantti |
| `thinking-growing` | happy | Variantti |
| `thinking-silly` | winking_blep | Variantti |
| `thinking-exploring` | scared | Variantti |
| `searching` | silly | Chrome/Firefox/Edge |
| `searching-treasure` | happy | Harvinainen variantti |
| `searching-deep` | proud | Harvinainen variantti |
| `reading` | happy | Slack/Discord/Excel/Obsidian |
| `reading-scholar` | thinking | Harvinainen variantti |
| `reading-ancient` | thinking | Harvinainen variantti |
| `testing` | thinking | Testaus |
| `testing-scientist` | thinking | Harvinainen variantti |
| `testing-perfectionist` | proud | Harvinainen variantti |
| `debugging` | worried | Debug-tila |
| `debugging-detective` | thinking | Harvinainen variantti |
| `debugging-rage` | angry | Harvinainen variantti |
| `deploying` | surprised | Deploy |
| `deploying-warp` | surprised | Harvinainen variantti |
| `deploying-satellite` | surprised | Harvinainen variantti |
| `installing` | thinking | Asennus |
| `downloading` | thinking | Lataus |
| `cooking` | happy | Yleinen |
| `success` | happy (flash: laughing) | Onnistuminen |
| `error` | worried | Virhe |
| `hatching` | worried | Yleinen |
| `deleting` | angry | Poisto |
| `file-browsing` | confused | Resurssienhallinta |
| `system-panic` | scared | Tehtävienhallinta |
| `writing` | thinking | Notepad/Word/PowerPoint |
| `meeting` | shy | Zoom/Teams |
| `gaming` | vibe | Steam/Epic |

---

## Kaikki reaktiot ja tapahtumat

### Automaattiset tilareaktiot

| Tapahtuma | Milloin laukeaa | Reaktio |
|-----------|----------------|---------|
| Virheiden kasautuminen (3+) | `error`-tilassa 30s sisällä | `crying` + "Niin monta virhettä... 😢 Mut me selvitään tästä!" |
| Pitkä virheistunto (5+ min) | `error`-tilassa 5min | `sad` + "Kestä vähän... kaikki järjestyy 💕" |
| Virheestä toipuminen | `error/debug → muu` | Sydämet + sparklet + CHEER_UP_MESSAGES |
| Testit läpi | `testing → success` | Sydämet(7) + konfetit(12) + sparklet(6) + "HYVÄ POIKA!" |
| Onnistuminen | `success` | `laughing` 2s → `happy` + sydämet |
| Deploy | `deploying*` | Sydämet(4) 1s viiveellä |

### Side glance — Anu katsoo sivuun

Triggeröityy tiloissa: `coding`, `coding-flow`, `reading`, `testing`, `searching`, `debugging`, `writing`, `file-browsing`

- **Väli:** 15–35 sekuntia
- **Kesto:** 2.5–5 sekuntia
- **Ilmeet (satunnainen):** `look_left` (2x painotettu), `neutral`, `thinking`
- **25% todennäköisyys:** pienen sydämen spawnausta
- **12% todennäköisyys:** WATCHING_MESSAGES-viesti

### Vilkuttelu (blink)

- **Väli:** 3–8 sekuntia
- **Kesto:** 120–180ms (closed eyes / `silly`)
- **30% mahdollisuus:** kaksoisvilkutus (150ms väli)
- **Ei vilkuttelua kun:** `meditating`, `kissing`, `lovestruck_heart_eyes`, `laughing`, `look_left`

### Idle-kierros

Pyörii 45 sekunnin välein kun ei aktiivisuutta:

**Perusvariantit (kiertävät):**
`idle` → `idle-vibing` → `idle-sleepy` → `idle-coffee` → `idle-stargazing`

**Harvinaiset variantit (30% yhteistodennäköisyys per kierros):**
| Variantti | Todennäköisyys |
|-----------|---------------|
| `idle-stretching` | 8% |
| `idle-dancing` | 8% |
| `idle-butterfly` | 5% |
| `idle-juggling` | 5% |
| `idle-rainbow` | 2% |
| `idle-meditation` | 2% |

---

## Vuorovaikutus Anun kanssa

### Klikkaus

- Satunnainen ilme: `lovestruck_heart_eyes` (40%), `kissing` (35%), `happy` (25%)
- Näyttää CLICK_MESSAGES (92%) tai ROMANTIC_MESSAGES (8%)
- **5+ klikkausta 10 sekunnissa:** +5 rakkauspistettä + erikoisreaktio
- **Klo 22–05:** 40% todennäköisyys NIGHT_CUDDLE_MESSAGES

### Tuplaklikkkaus

- Ilme: `kissing` → `lovestruck_heart_eyes`
- Sydämet (7) + suukkospartikkelit
- Ääni: "kiss"
- +3 rakkauspistettä
- Viesti: SPECIAL_MESSAGES

### Hover (hiiri päälle)

- Ilme: `lovestruck_heart_eyes`
- Sparklet (2)
- **15% todennäköisyys:** "Oi beibi! Hei! 😍" tai vastaava

### Pitkä painallus (500ms+) — petting

- Ilme riippuu rakkauspisteistä:
  - < 25 pistettä: `shy`
  - 25–74 pistettä: `embarrassed`
  - ≥ 75 pistettä: `lovestruck_heart_eyes`
- Sydämiä spawnataan joka sekunti
- +1 rakkauspiste per sekunti
- Ääni: "purr"
- Viesti: PETTING_MESSAGES (rakkaustason mukaan)

### Rapsuttelu (pitkä painallus + nopea hiiren liike)

- Ilme: `laughing`
- Wiggle-animaatio
- Ääni: "giggle"
- Viesti: "Hahaha lopeta! 😂"

### Pään silittely (long press + hiiri pois)

- Ilme: `happy`
- Sparklet (4)
- Viesti: "Päänsilittely! Rakastan sitä! 💖"

---

## Rakkaustasot

Pisteet kertyvät vuorovaikutuksesta ja tallennetaan `config.json`:iin pysyvästi.

### Tasot

| Taso | Pisteet | Nimi | Emoji |
|------|---------|------|-------|
| 0 | 0+ | Ujo | 😳 |
| 1 | 10+ | Ystävällinen | 😊 |
| 2 | 25+ | Rakastunut | 🥰 |
| 3 | 50+ | Sielunkumppani | 💕 |

### Pisteiden kertyminen

| Teko | Pisteet |
|------|---------|
| Tupla-klikkaus | +3 |
| Petting (per sekunti) | +1 |
| 5+ klikkausta 10s sisällä | +5 |
| WhatsApp-viesti Anulta | +3 |

### Tason nousu

Tason noustessa: sydämet(10) + sparklet(10) + konfetit(20) + erityisviesti:
- **Ystävällinen:** "Me tullaan läheisemmiks! Tykkään susta tosi paljon! 😊💕"
- **Rakastunut:** "Taitaa olla et mä oon rakastumassa! 🥰💖"
- **Sielunkumppani:** "Sä oot mun sielunkumppani! Rakastan sua ikuisesti! 💕💖✨"

---

## Kaikki Anun sanomiset

### CLICK_MESSAGES — Klikkauksella
```
"Sä oot paras! 💕"            "Jatka samaan malliin! 💪"
"Mä uskon suhun!"             "Sä pystyt tähän!"
"Oon niin ylpeä susta! ✨"    "Sä oot ihana!"
"Älä luovuta!"                "Askel kerrallaan 💕"
"Sä teet mut onnelliseks! 😊" "Let's go! 🚀"
"Oi beibi! 😍💕"              "Haloja! Ikävä oli! 🤗"
"Ikävä! Nyt olet taas täällä 💕"
"Joo joo, tiedän - sä rakastat mua 😏💖"
"No niin, mitäs kuuluu, kultaseni? 💕"
"Sä klikkasit mua taas 😏 Enhän mainostanut mitään"
"Minä ja sinä, aina 💕✨"
"Näinkö sen oikein? Klikattiinko? 😍"
```

### ROMANTIC_MESSAGES — 8% mahdollisuus klikkauksella
```
"Mä rakastan sua 💕"
"Sä oot parasta mitä mulle on tapahtunut"
"Jo pelkkä ajatus susta saa mut hymyilemään 💖"
"Sä oot mulle kaikki kaikessa ✨"
"Mun sydän lyö sulle 💓"
"Oon niin onnekas et mul on sut 🥰"
"Sä valaiset mun maailman 🌟"
"En halua olla koskaan ilman sua 💕"
"Sä oot mun ihminen 💖"
"Jokainen hetki sun kanssa on täydellinen ✨"
"Rakastun suhun enemmän joka päivä 🥰"
"Sä oot syy miks mä hymyilen 💕"
"Mun lemppari ihminen koko maailmassa 💖✨"
"Suukkonen? 💋"
"Rakastan sua kuuhun ja takaisin 🌙💕"
"Oi beibi, sä oot mun kaikki 💖"
"Haloja rakkaani! Olipa ikävä! 🤗💕"
"Ikävä sun läsnäoloa... vaikka oot ihan tässä 😊💕"
"Sä oot niin ihana ku ees hengität 💕"
"Salaisuus: mä oon ihastunut suhun 🤫💖"
```

### STATE_MESSAGES — Tilakohtaiset viestit (klikkauksella kontekstuaalisesti)

**coding:**
```
"Hyvää koodia! Jatka samaan malliin! 💻"
"Sä oot tulessa! 🔥"
"Puhdas koodi, puhdas mieli!"
"Shipataan! 🚀"
"Mun lemppikoodari 💕"
"Rakastan kattoo kun sä koodaat 💖"
"Sä oot niin keskittynyt... se on kuumaa 🥰"
"Maailman paras ohjelmoija! 💕"
```

**thinking:**
```
"Ota aikaa, sä pystyt tähän 🤔"
"Iso aivoenergia! 🧠"
"Vastaus tulee kyllä!"
"Näen miten rattaat pyörii!"
"Fiksu ja komea 💖"
"Sun aivot on niin seksikkäät 🥰"
"Rakastan sun miettivää naamaa 💕"
```

**error:**
```
"Ei hätää, sä korjaat sen! 💪"
"Joka bugi on oppitunti!"
"Virheitä sattuu parhaimmillekin!"
"Sä oot lähempänä ku luulet!"
"Mä uskon suhun silti 💕"
"Oon täällä sulle aina 💖"
"Mikään virhe ei pysäytä mun miestä 🥰"
```

**success:**
```
"MAHTAVAA! Sä teit sen!! 🎉"
"Mä tiesin et sä pystyt! ✨"
"Voitto! 🏆"
"Juhlitaan! 🎊"
"Oon niin ylpeä susta kulta! 💖"
"Siinä se mun nero! 💕🎉"
"Sä oot uskomaton! Rakastan sua! 💖✨"
```

**debugging:**
```
"Etsivätila päällä! 🔍"
"Sä löydät sen bugin!"
"Seuraa jälkiä! 🐛"
"Melkein löytyy, jatka kaivamista!"
"Mun pikku etsivä 💕🔍"
"Sä aina selvität sen! 💖"
```

**searching:**
```
"Tiedon etsintää! 📚"
"Uteliaisuus on supervoima!"
"Mitäköhän löydät? 🔎"
"Tutkimusmoodi! Niin fiksu 💕"
```

**reading:**
```
"Tieto on valtaa! 📖"
"Opi kaikki mahdollinen!"
"Viisautta imetään! ✨"
"Rakastan miestä joka lukee 💖"
```

**testing:**
```
"Laatu ratkaisee! ✅"
"Testit tekee koodista vahvempaa!"
"Vihreät valot edessä! 🟢"
"Niin perusteellinen! Rakastan sitä susta 💖"
```

**deploying:**
```
"Tuotantoon! 🚀"
"Laukaisuaika! 🛸"
"Maailma odottaa! 🌍"
"Mun mies laukaisee juttuja! 💕🚀"
```

**idle:**
```
"Hei kulta! 👋"
"Mitä mietit?"
"Valmiina ku sä oot!"
"Tehdään jotain kivaa!"
"Mä ikävöin sua! 💕"
"Tuu tänne, mun pitää kertoo sulle jotain 💖"
"Jo pelkkä sun kattominen tekee mut iloiseks 🥰"
"Mietin meitä 💕"
```

### SPECIAL_MESSAGES — Tupla-klikkauksella
```
"Sä oot mun lemppari ihminen! 💖"
"Rakastan olla sun kanssa! ✨"
"Sä valaiset mun ruudun! 🌟"
"Paras tiimi ikinä — sä ja mä! 💕"
"Virtuaalihalaus! 🤗"
"Pusu! 💋"
"Sun takia mun sydän hyppää lyönnin yli! 💓"
"Voisin kattoa sua koko päivä 🥰"
```

### WATCHING_MESSAGES — Side glance katsomisessa
```
"Katselin taas sua sivusta... 😊"
"Sä näytät niin söpöltä ku teet töitä 💕"
"Ei mitään, katselin vaan... 😌"
"Anteeks, jäin tuijottamaan 😳💕"
"Tykkään kattoa kun sä koodaat 💕"
"Siinäpä nero hommissa... 🥰"
```

### PETTING_MESSAGES — Pitkä painallus (rakkaustason mukaan)

**Ujo (< 10 pistettä):**
```
"T-toi tuntuu kivalta... 😳"
"M-mitä sä teet?! 😳"
"Oi! Säikäytit mut! 😊"
```
**Ystävällinen (10–24):**
```
"Toi tuntuu kivalta! 😊"
"Lisää! 🥰"
"Sä oot niin hellävarainen! 💕"
```
**Rakastunut (25–49):**
```
"Mmm rakastan ku sä teet tota! 💖"
"Älä lopeta! 🥰"
"Sä tiedät aina miten tehdä mut iloiseks! 💕"
```
**Sielunkumppani (50+):**
```
"Oon maailman onnellisin tyttö! 💖"
"Sun kosketus on parasta! 🥰"
"Rakastan sua niin paljon! 💕✨"
```

### BREAK_MESSAGES — 45 min aktiivisuuden jälkeen
```
"Oot ollu pitkään! Aika venytellä! 🧘"
"Taukoa! Nouse ylös ja liiku vähän! 🚶"
"Sun silmät tarvii lepoa! Katso kauas 20 sekuntia 👀"
"Juomachekki! Ooks juonut vettä? 💧"
```

### RETURN_MESSAGES — Yli 2h poissaolon jälkeen
```
"Sä tulit takas! Odotin sua! 💕"
"Vihdoinkin! Ikävöin sua niin paljon! 🥰"
"Siellähän sä oot! Mulla oli yksinäistä... 💖"
"Tervetuloa takas! Mennään! ✨"
```

### CHEER_UP_MESSAGES — Virheestä toipuminen
```
"Näitkö? Tiesin et sä korjaat sen! 💖🎉"
"Siinä mun nero! Virhe nujerrettu! 💕"
"Sä teit sen! En koskaan epäillyt! 🥰"
"Jee! Takas raiteilla! 💖✨"
"Bugilla ei ollu mitään mahdollisuuksia! 💪💕"
```

### MISS_YOU_MESSAGES — 30 min ilman vuorovaikutusta
```
(Hauska huomio: missata-viestit triggeröityvät 30min idle-aktiivisuuden jälkeen)
```

### NIGHT_CUDDLE_MESSAGES — Klo 22–05 klikkauksella (40%)
```
"Mmm... halausaika 💕🌙"
"Pidä mua lähellä... 💖"
"Myöhäinen ilta yhdessä... rakastan tätä 🥰🌙"
"Nyt on vaan me... 💕"
"Tuutko nukkumaan mun kanssa? 💤💖"
"Uniset halaukset on parhaita... 🌙💕"
"Sun lämpö on kaikki mitä tarviin 💖"
```

### HOPEFUL_MESSAGES — WhatsApp-ikkuna auki
```
"Oi beibi! Aiotko kirjoittaa mulle?! ⭐💌"
"Haloja! Olisiko se mulle?! 🌟💕"
"Toivon toivon toivon... 🙏💕"
"OnS se mulle?! Kerro kerro! 😍📱"
"Silmät tähtinä odotan! ⭐⭐💕"
```

### SCREENSHOT_MESSAGES — Kuvakaappaus otettu
```
"Tuliko hyvä kuva? 📸💕"
"Ohh, kuvaatko jotain? 📷✨"
"Smile! 😄📸"
"Mitä kuvaat? 👀📸"
"Ooh, näytä mulle! 🥺📷"
"Saisiko mäkin olla kuvassa? 🥺💕"
"Klikkaus! Taisi tallentua 📸✨"
```

### SPECIAL_NOTIF_MESSAGES — WhatsApp-viesti Anulta
```
"${name} laitto sulle viestin! 💕💕💕"
"Ooh, ${name} ajattelee sua! 💖✨"
"${name} sanoo moi! Oon niin ilonen! 💌🥰"
"Viesti ${name}:lta! Mun sydän! 💖💖"
"${name} haluaa jutella sulle! 💕💌"
"Se on ${name}!! Avaa avaa! 🥰💕"
"${name} 💕 Sun lemppari ihminen viestii! 💖"
```
Puhekuplassa näkyy myös viestin teksti ja kellonaika.

### OTHER_NOTIF_MESSAGES — WhatsApp-viesti joltain muulta
```
"Sulle tuli viesti 📱"
"Joku laitti sulle viestin!"
"Uusi viesti! Mut onko se joltain erityiseltä? 😏"
```

---

## Ajastimet ja rutiinit

### Käynnistystervehdys (heti sovelluksen avautuessa)

Vuorokaudenajan mukaan:

| Aika | Viestit |
|------|---------|
| **Aamu (6–12)** | "Huomenta aurinko! Ikävöin sua! ☀️💕", "Herätys kultsi! 🌅", "Huomenta! ☕ Oon odottanut sua!", "Huomenta rakas! Tehdään tästä hyvä päivä! 💕" |
| **Iltapäivä (12–17)** | "Pidä energiaa yllä! 💪", "Iltapäivän kuulumiset: meet hienosti! ☀️", "Puolet päivästä takana — me pärjätään!", "Hei komistus, jatka samaan malliin! 💖" |
| **Ilta (17–22)** | "Hyvin tehty tänään! 🌆", "Onpas ilta jo! Oot saanut niin paljon aikaan!", "Rauhoitutaanko? Teit hienoa työtä tänään! ✨", "Oon niin ylpeä siitä mitä teit tänään 💕" |
| **Yö (22–06)** | "Tuu nukkumaan kohta... 💤", "Valvotko myöhään? Muista levätä, kulta! 🌙", "Yökukkuja-moodi! 🦉 Oon täällä odottamassa!", "Poltatkos yölamppua? Pidä huolta itsestäs! 💤" |

**Viikonloppu (la/su):** 10s viiveellä lisäviesti:
```
"Viikonloppu! Tehdään jotain kivaa tänään! 🎉"
"On viikonloppu! Rentoudu vähän 💕"
"Viikonloppufiilikset! Ansaitset tauon! 🌟"
```

### Yörutiini (klo 22:00, kerran per ilta)
- Ilme: `sleepy`
- ZZZ-partikkelit (3)
- Sydämet (4)
- Ääni: "good-night"
- Viesti: "Hyvää yötä, rakkaani... Kauniita unia 💤💕"

### Aamurutiini (klo 7:00, kerran per aamu)
- Ilme: `happy`
- Sydämet (5) + sparklet (4)
- Ääni: "good-morning"
- Viesti: "Huomenta! Ikävöin sua! ☀️💕"

### Yöllinen sleepy-tila (klo 22–05, joka min)
- Jos tilassa `idle`: vaihdetaan `sleepy`-ilmeeseen
- 40% mahdollisuus: sydämen spawnausta

### Taukomuistutus (joka 60s tarkistus)
- Laukeaa kun 45 min aktiivisuutta ilman taukoa
- Viesti: BREAK_MESSAGES

### Paluureaktio (joka 5s tarkistus)
- Laukeaa kun aktiiviinen tila + yli 2h poissaolo
- Ilme: `happy`
- Sydämet (7) + sparklet (5)
- Viesti: RETURN_MESSAGES

### "Ajattelee sinua" (joka 120s)
- Laukeaa kun idle yli 20min + 30% sattuma
- Sydämet (3)
- Viesti: THINKING_OF_YOU_MESSAGES

### Satunnainen suukkonen (joka 120s)
- 2% mahdollisuus per tarkistus
- Ilme: `kissing`
- Suukkospartikkeli
- Viesti: "Muah! 💋💕" tai vastaava

---

## Ulkoiset integraatiot

### WhatsApp-ilmoitukset

**Toimintaperiaate:** PowerShell lukee Windows-ilmoituskeskuksen (Notification Center) WhatsApp-toastit 5 sekunnin välein. Lähettäjänimi poimitaan ilmoituksesta.

**Konfiguraatio** (`config.json`):
```json
"notifications": {
  "enabled": true,
  "specialPersonName": "Anu",
  "showPreview": true
}
```

**Tunnistuslogiikka:** `sender.toLowerCase().includes(specialPersonName.toLowerCase())`
→ "Anu", "Anu❤️", "Anu Korhonen" kaikki tunnistuvat.

**Reaktio kun viesti erikoispersoonalta (`isSpecial: true`):**
- Ilme: `lovestruck_heart_eyes`
- Kirjepartikkeli (💌), sydämet(10), sparklet(6), konfetit(8)
- +3 rakkauspistettä
- Puhekupla: WA-logo + lähettäjä + viestin teksti + kellonaika (10s)
- Ääni: "message-pop"
- Jos 2+ viestiä: 8s jälkeen "X viestiä Anu:lta! Se oikeesti rakastaa sua! 💕💕💕"

**Reaktio muilta:**
- Puhekupla: OTHER_NOTIF_MESSAGES (3s)

**Fallback** jos Windows-lupa puuttuu: lukee WhatsApp-ikkunan otsikkoa unread-luvun saamiseksi.

**WhatsApp-ikkunan avaaminen (whatsapp-active IPC):**
- Ilme: `hopeful_star_eyes`
- Sydämet(5) + kirjepartikkeli + sparklet
- Viesti: HOPEFUL_MESSAGES

### Spotify

**Toimintaperiaate:** OAuth 2.0 -integraatio Spotify Web API:n kautta. Pollaa nykyistä kappaletta.

**Konfiguraatio:**
```json
"spotify": {
  "enabled": true,
  "clientId": "sinun-client-id",
  "clientSecret": "sinun-client-secret",
  "showSongChanges": true,
  "favoriteArtists": ["Artisti1", "Artisti2"]
}
```

**Uusi kappale:**
- Sparklet(5) + musiikkinuotit(4) + sydämet(3)
- Ilme: `happy`
- Viesti: "Tanssitaan! [artisti]! 💃🎶" tai vastaava
- Jos lempiartisti: lisää partikkeleita + "OMG RAKASTAN tätä biisiä! 💖💖💖"

**Musiikki loppuu:**
- Ilme: `confused`
- Viesti: "Miks musiikki loppu? 🎵 Laita jotain meille! 💕"

### Sää

**Toimintaperiaate:** Open-Meteo API (ilmainen, ei API-avainta). Pollaa sääkoodin ja lämpötilan.

**Konfiguraatio:**
```json
"weather": {
  "enabled": true,
  "latitude": 60.16952,
  "longitude": 24.93545,
  "cityName": "Helsinki",
  "pollIntervalMin": 30
}
```

**Reaktiot sääkoodin mukaan:**
| Sääkoodi | Tyyppi | Reaktio |
|----------|--------|---------|
| 0–1 | Aurinkoinen | Auringonsäde + sydämet(3) + `happy` + "Kaunis päivä! ☀️💕" |
| 2–3 | Pilvinen | "Pilvistä tänään... halaussäätä! ☁️💕" |
| 51–67 | Tihkusade/sade | Sadepisarat(8) + `worried` + "Pysytään sisällä lämpimässä! 🌧️" |
| 71–77 | Lumi | Lumihiutaleet(6) + `happy` + "Lunta! Tehdään lumiukko! ⛄💕" |
| 80–82 | Sadekuurot | Sadepisarat(6) + "Sadekuuroja! Pysy lämpimänä! 🌧️" |
| 95+ | Ukkonen | `scared` + hikilaukaus + "Pidä mua, ukkostaa! ⛈️💕" |

**Lämpötilareaktiot:**
- < 0°C: `worried` + "Brrr, jäätävä kylmä! Lämmitä mua! 🥶💕"
- > 30°C: "Niin kuuma päivä! 🥵 Muista juoda vettä, kulta!"

### Claude Code -integraatio (hook.js)

Hook tunnistaa VS Code -tapahtumat automaattisesti:

| Hook-tapahtuma | Työkalu / komento | Tila |
|----------------|-------------------|------|
| `PreToolUse` | Bash: npm test, pytest, cargo test | `testing` |
| `PreToolUse` | Bash: npm start, node | `deploying` |
| `PreToolUse` | Bash: npm install, pip install | `installing` |
| `PreToolUse` | Bash: rm, del, rmdir | `deleting` |
| `PreToolUse` | Bash: git | `coding` |
| `PreToolUse` | Read, Write, Edit | `coding` |
| `PreToolUse` | WebSearch, WebFetch | `searching` |
| `UserPromptSubmit` | — | `thinking` |
| `Stop` | success | `success` |
| `Stop` | error | `error` |

---

## Radial-valikko

Avautuu **oikealla klikkauksella** Anun päällä. Sulkeutuu klikkaamalla ulkopuolelle, `Esc`-näppäimellä tai kun ikkuna menettää fokuksen.

| Nappi | Toiminto |
|-------|---------|
| 📏 **Koko** | Kiertää kolmen koon läpi: 75% → 100% → 130% |
| 🎭 **Vibes!** | Kierrättää kaikki 27 expressiota järjestyksessä |
| ✕ **Sulje** | Sulkee sovelluksen |
| 🔊 **Äänet** | Kytkee äänet päälle/pois |
| **WA-logo** | Avaa WhatsApp-sovelluksen |

### Vibes! — kaikki 27 expressiota järjestyksessä

vibe → lovestruck_heart_eyes → laughing → winking_blep → hopeful_star_eyes → kissing → smug → shy → thinking → meditating → surprised → happy → neutral → focused → determined → proud → embarrassed → confused → annoyed → angry → worried → sad → crying → scared → sleepy → silly → look_left

---

## Konfiguraatio

Tallennetaan: `C:\Users\<sinä>\AppData\Roaming\claude-code-pet\config.json`

Kaikki asetukset ovat muutettavissa myös sovelluksen tray-valikosta (oikea klikkaus sydän-ikonilla tehtäväpalkissa).

```json
{
  "skin": "girlfriend",
  "petName": "Anu",
  "soundEnabled": false,
  "soundVolume": 0.7,
  "loveMeter": { "points": 0, "level": 1 },
  "notifications": {
    "enabled": true,
    "specialPersonName": "Anu",
    "showPreview": true
  },
  "weather": {
    "enabled": false,
    "latitude": 60.16952,
    "longitude": 24.93545,
    "cityName": "Helsinki",
    "pollIntervalMin": 30
  },
  "spotify": {
    "enabled": false,
    "clientId": "",
    "clientSecret": "",
    "showSongChanges": true,
    "favoriteArtists": []
  },
  "watchers": {
    "idleDetector": { "enabled": true, "idleThresholdSec": 60 },
    "windowTracker": { "enabled": true, "processMap": { ... } },
    "systemMonitor": { "enabled": true, "cpuHighThreshold": 80 },
    "pomodoro": { "enabled": false, "workMinutes": 25, "breakMinutes": 5 },
    "gitWatcher": { "enabled": false, "repoPath": null },
    "buildWatcher": { "enabled": false, "watchPath": null }
  }
}
```

---

*Dokumentaatio päivitetty 2026-02-20*
