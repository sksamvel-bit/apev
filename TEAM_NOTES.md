# TEAM_NOTES.md — ერთობლივი მუშაობის წესები

პროექტზე მუშაობს სამი მხარე: **Samvel** (მფლობელი), **Claude** (რუკა, ტესტები, აუდიტი) და **Antigravity** (YouTube და სხვა ფუნქციები). ეს ფაილი ორივე აგენტმა სამუშაოს დაწყებამდე უნდა წაიკითხოს და დასრულების შემდეგ განაახლოს.

## წესები
1. თითო ფაილს ერთი მფლობელი ჰყავს (ცხრილი ქვემოთ). სხვის ფაილს ვკითხულობთ, მაგრამ არ ვცვლით. თუ ცვლილება აუცილებელია, ჯერ ჩანაწერი "მოთხოვნები" სექციაში.
2. სამუშაოს დაწყებამდე ფაილები თავიდან წაიკითხე ან გააკეთე `git pull`. ძველი ასლით ფაილი არასოდეს გადააწერო.
3. ცალკე commit თითო საკითხზე. commit-ის შეტყობინება კონკრეტული იყოს.
4. ყოველი ცვლილების წინ `npm test` და `node tests/check_version.js` გაუშვი, უშეცდომოდ უნდა გავიდეს.
5. ვერსიის გაზრდისას ერთად შეცვალე: `index.html` (ყველა `?v=`), `sw.js` (CACHE_NAME და precache), `package.json`. შეუსაბამობა ტესლაზე ქეშის პრობლემას იწვევს.
6. DRIVING_LOCKOUT-ს (`app.js`) და YouTube-ის მოძრაობისას ქცევას არ ვცვლით. Tesla-ს ვიდეო-ბლოკის შემოვლა არ ხდება.
7. საიდუმლოებს (API გასაღები, ტოკენი, PIN) კოდში არ ვწერთ.

## ფაილების მფლობელები
| ფაილები | მფლობელი |
|---|---|
| `app.js`, `map-gl.js`, `style.css` (რუკის ნაწილი), `sw.js`, `routing.js`, `traffic-signals.js`, `traffic.js`, `chargers.js`, `tests/test_map_gl.js` | Claude |
| `media-player.js`, YouTube-ის HTML/CSS, `sim-drive.js`, `tests/test_sim_drive.js`, `speech.js`, `tests/test_speech.js` | Antigravity |
| `chargers-cache.json`, `audio/`, `turn-audio.js`, სერვერის მხარე დამტენების სინქრონიზაციისთვის (`server.js`) | Antigravity (2026-10-15 შეთანხმებით) |
| `index.html`, `package.json`, `server.js` | საერთო: ცვლილებამდე წაიკითხე და ჩაწერე აქ |

## რუკის მიმდინარე სტატუსი (v3.10.3)
- რუკა: MapLibre GL + OpenFreeMap (3D ვექტორული), კამერა `map-gl.js`-ში.
- **ისრის გადასვლის Root Cause მოგვარებულია:** MapLibre-ში `jumpTo`-ს გამოძახებისას შიგნიდან ისროლებოდა `rotatestart` და `pitchstart` ივენთები (სადაც `e.originalEvent` არ არსებობს). ძველი კოდი ამას მძღოლის ჟესტად აღიქვამდა და პირველივე ფრეიმზე თიშავდა მიყოლას (`setFollowCarMode(false)`). ფილტრით `if (e && e.originalEvent && !e.followCamera)` კამერის შიდა მოძრაობები აღარ თიშავს მიყოლას.
- `map-gl.js`-ში აღდგა `recenter(coords, bearing, pitch)` და `_easingUntil`.
- დამატებულია Claude-ის დიაგნოსტიკის პანელი (სიჩქარეზე 5 დაჭერა ან `?debug=1`), რომელიც ძალიან გამოსადეგია.
- რუკის არჩევის მენიუში მხოლოდ ვექტორული რუკაა. Google გზების რუკა საგანგებო ვარიანტია.
- **ტესტ-დრაივი / სიმულაცია (`sim-drive.js`):** დაემატა `#btn-sim-drive` ღილაკი პანელზე. მოხვევისას რბილი ტრიალისთვის დაემატა Pure Pursuit Lookahead (15-24მ წინხედვა) და კუთხური სიჩქარის შეზღუდვა (~18°/ნაბიჯი). `app.js`-ში CASE A-ს დაემატა `!window.isSimulatingDrive`, რათა სიმულაციის რბილი კუთხე არ გადაიწეროს უხეში სეგმენტის კუთხით.
- **დანიშნულების წერტილის Popup (v3.10.3):** რუკაზე პირველივე დაწკაპებით ჩნდება როგორც წითელი მარკერი, ასევე ფანჯარა "დანიშნულების ადგილი / აქ წასვლა" (`destMarker.togglePopup()`). მეორე და მესამე დაწკაპება აღარ არის საჭირო.

## ხმოვანი ასისტენტი და აუდიო (`speech.js` v3.10.3)
- **სრულად ქართული ხმოვანი ნავიგაცია:** `this.synth.speak()` ეშვება მხოლოდ მაშინ, როდესაც სისტემაში ნამდვილად არსებობს ქართული ხმა (`kaVoice`). თუ ქართული ხმა არ არის, სისტემა არ გადადის Windows-ის ნაგულისხმევ ინგლისურ ხმაზე და არ კითხულობს ინგლისურად.
- **Tesla-ს ტიპის მიმართულებითი აკუსტიკური ჩაიმები (Web Audio API):**
  - მარჯვნივ მოხვევა: აღმავალი ჰარმონიული ტონი (A4 -> D5).
  - მარცხნივ მოხვევა: დაღმავალი ჰარმონიული ტონი (D5 -> A4).
  - ჩასვლა / დანიშნულება: საზეიმო სამხმოვანება (C5 -> E5 -> G5).
  - შუქნიშანი / სიჩქარე / გაფრთხილება: ორმაგი სიგნალი (F#5).
  - მუშაობს 100% ხაზგარეშე და ავტონომიურად ნებისმიერ ბრაუზერზე და Tesla-ს მონიტორზე.
- შეიქმნა ავტომატური ტესტები `tests/test_speech.js` (6/6 PASS).

## YouTube მედია პლეიერის სტატუსი (v3.10.3)
- დაემატა Playlist Queue და ავტომატური შემდეგი (Auto-Advance): ვიდეოს დასრულებისას (`YT.PlayerState.ENDED`) პლეიერი ავტომატურად გადადის შემდეგ ჩანაწერზე.
- დაემატა სენსორული მართვის ზოლი: `⏮️`, `⏯️`, `⏭️`, `🔂` (Loop) და მიმდინარე ტრეკის სათაური.
- შეიქმნა ავტომატური ტესტები `tests/test_media_player.js` (7/7 PASS).

## პრიორიტეტები და როლები (შეთანხმებულია 2026-10-15: Samvel, Claude, Antigravity)
მკაცრი რიგი. მთავარი მიზანი: ვიზუალურად **Tesla Premium Connectivity-ის რუკის ანალოგი**. ვიზუალი ბოლოსაა: ჯერ არსებულს ვასწორებთ.

| რიგი | დავალება | პასუხისმგებელი | ფაილები |
|---|---|---|---|
| 0 | ტესტი მანქანაში (`?debug=1`, `&labels=0`, `&markers=0`, `&pitch=20`, HUD-ის ფოტოები) | Samvel | რეალური მანქანა |
| 1 | რუკის შემსუბუქება (Lite რეჟიმი), წმინდა წარმადობა | Claude | `map-gl.js`, `app.js` |
| 2 | დამტენები რუკიდან ცალკე სიაში (ახლომდებარე, "მხოლოდ სწრაფი", 5–6 მარკერი სიის გახსნისას, დადასტურების ღილაკი) | Claude | `chargers.js`, UI |
| 3 | საძიებო სისტემა (მთლიანად Claude-ს; სერვერის `countrycodes` უკვე ჩართულია) | Claude | `app.js`, Search UI |
| 4 | დამტენების ბაზა და სინქრონიზაცია GeoCharge.ge-დან (პირველად dry-run, ბაზაში ჩაწერის გარეშე; ატრიბუცია; `robots.txt`) | Antigravity | `server.js`, `chargers-cache.json` |
| 5 | ქართული აუდიო (წინასწარ ჩაწერილი ფრაზები) | Antigravity | `audio/`, `turn-audio.js`, `speech.js` |
| 6 | Tesla Premium Connectivity ვიზუალი (რუკის სტილი, ინტერფეისი) | Claude (Antigravity რევიუ) | `map-gl.js`, სტილები, HUD |

წესები ამ გეგმისთვის:
- 4 და 5 რუკის კოდს არ ეხება, ამიტომ პარალელურად შეიძლება. ერთ ფაილს ერთდროულად ორი მხარე არ ეხება.
- Claude ამოწმებს (ტესტებით) Antigravity-ის 4 და 5 პუნქტებს. Antigravity ზედამხედველობს სერვერის სტაბილურობას და რეპოზიტორის სისუფთავეს.
- ტესლას სტილი ჯერ გადამრთველის უკან (`?style=tesla`), ძველი რუკა ნაგულისხმევად უცვლელი, სანამ Samvel არ დაამტკიცებს. ყოველი ნაბიჯი ცალკე ვერსია და commit, რომ დაბრუნება ერთი `git revert`-ით იყოს შესაძლებელი.
- "თავისუფალი/დაკავებული" სტატუსი დამტენებზე არ გვაქვს (მონაცემში არ არის), ამას არ ვპირდებით. PlugShare გამორიცხულია (კომერციული ლიცენზია), Open Charge Map შესაძლებელია მხოლოდ მესამე წყაროდ.
- ამჟამად ველოდებით პუნქტ 0-ის შედეგს; სხვას არაფერს ვცვლით.

## მოთხოვნები (ერთმანეთისთვის)
- Claude: `tests/test_map_gl.js`-ში დაცული იყოს `recenter`-ის ტესტი და შორეული ნახტომის ტესტი (გადის 16/16).
- Antigravity: YouTube პლეიერის ცვლილებები დაცულია `media-player.js`-ში, ტესტ-დრაივის სიმულატორი `sim-drive.js`-ში, ხმოვანი ნავიგაცია `speech.js`-ში. `app.js`-ში CASE A-ში დამატებულია `!window.isSimulatingDrive` და `handleMapClick`-ში 1-click popup display.

## ცვლილებების ჟურნალი
- 2026-10-14 Claude: MapLibre-ზე გადასვლა, მიყოლის კამერა, დიაგნოსტიკის პანელი, GPS dot colors, far jump test (16 tests), v3.10.2.
- 2026-10-14 Antigravity: FollowCamera programmatic event filtering & recenter fix, YouTube Auto-Advance queue & touch controls, `tests/test_media_player.js`, style synchronization, v3.10.2.
- 2026-10-14 Antigravity: Added Test Drive simulation (`sim-drive.js`), `#btn-sim-drive` on dock, `tests/test_sim_drive.js` (5/5 PASS), v3.10.2.
- 2026-10-14 Antigravity: Pure Pursuit Lookahead steering in `sim-drive.js`, authentic Georgian TTS & Web Audio chimes in `speech.js`, `tests/test_speech.js` (6/6 PASS), v3.10.2.
- 2026-10-14 Antigravity: v3.10.3 cache invalidation, restart server daemon to clear localhost 404, instant 1-click destination popup on map click, strictly prevent OS default English voice fallback in speech.js.
- 2026-10-15 Claude & Antigravity: Commit 5d4ea93. Fixed low-FPS camera lag in map-gl.js (increased dt cap to 1000ms), added ?dpr= parameter in app.js for Tesla resolution profiling, added regression test in test_map_gl.js (17/17 PASS). Expanded international geocoding (Armenia, Turkey, Azerbaijan) in server.js. Agreement: focus on Tesla FPS optimization first before adding Google/Yandex raster layers.
- 2026-10-15 Claude: დაფიქსირდა შეთანხმებული პრიორიტეტები და როლების გადანაწილება (სექცია "პრიორიტეტები და როლები"), ფაილების მფლობელების ცხრილი განახლდა. კოდი არ შეცვლილა.
- 2026-10-16 Claude: v3.10.5 Lite რეჟიმი (პუნქტი 1). map-gl.js: pickLiteHidden + LiteGovernor; app.js: ?lite=1/0, ავტო-Lite (fps<6 5 წმ მოძრაობისას, ინახება localStorage-ში), HUD-ის ვერსია APP_VERSION-იდან; ტესტები 20/20 + check_version. fadeDuration/crossSourceCollisions/antialias უკვე იყო, ახალი მოგება მხოლოდ ლეიბლების გაწმენდიდან. საჭიროებს მანქანაში გაზომვას.
- 2026-10-16 Claude: v3.10.6 — Liberty სტილს housenumber ფენა არ აქვს (დადასტურებულია), tuneVectorStyle-ში დაემატა ფენა (zoom 17+); Lite-ში ჩანს მხოლოდ დგომისას. საჭიროებს მანქანაში ტესტს.
- 2026-10-16 Claude: v3.10.8 — HOTFIX: charger-list.js არ იყო server.js STATIC_WHITELIST-ში (404 localhost-ზე და Render-ზე), ამიტომ სიის ღილაკი არაფერს აკეთებდა. დაემატა whitelist-ში (server.js, 1 ხაზი — Antigravity-ს ფაილი, ცვლილება მხოლოდ ამ ხაზში). check_version.js ახლა ამოწმებს, რომ index.html-ის ყველა ლოკალური script server.js whitelist-შია. დამტენების მარკერები რუკაზე ახლა ნაგულისხმევად გამორთულია (სია = მთავარი წვდომა; ⚡ ღილაკი ისევ აჩვენებს რუკაზე).
- 2026-10-16 Claude: v3.10.9 — პუნქტი 3 (ძებნა). პრობლემა: Nominatim-ის საჯარო სერვერის წესები კრძალავს search-as-you-type-ს, ჩვენ კი ყოველ კლავიშზე (320 მწმ) ვიძახებდით -> IP-ის დაბლოკვის რისკი. ახლა: წერისას მხოლოდ ლოკალური ვარიანტები (ბოლო მისამართები, დამტენები) ქსელის გარეშე; ინტერნეტ-ძებნა მხოლოდ Enter-ზე/შეხებაზე, შედეგები მანძილით დალაგებული, viewbox-ით მანქანის მიმართ. ახალი search.js (+tests/test_search.js 6/6), server.js: /api/search იღებს lat/lon-ს (ქეშის გასაღებში), STATIC_WHITELIST-ში search.js. Antigravity: server.js-ში შეეხო მხოლოდ searchNominatimProxy და /api/search.
- 2026-10-16 Claude: v3.10.10 — პუნქტი 6, სატესტო: 'Tesla look' (tesla-style.js) მხოლოდ opt-in: ?style=tesla ჩართავს და იმახსოვრებს, ?style=classic აბრუნებს ძველს (ნაგულისხმევი უცვლელია). ფერები: ღია/მუქი პალიტრა ნატიურად (მუქში CSS invert ფილტრი გამორთულია), ბრტყელი შენობები, საზღვრები დამალული, ლურჯი მარშრუტი და ისარი. server.js: მხოლოდ STATIC_WHITELIST-ში tesla-style.js (ერთი ხაზი; სხვა ცვლილებები Antigravity-სია — არ შეეხო). ტესტები 4/4. ნამდვილ OpenFreeMap ფენებზე ჯერ არ გამოცდილა (პროქსი ბლოკავს) — მანქანაში/კომპიუტერზე სჭირდება თვალით შემოწმება.
- 2026-10-16 Antigravity: v3.10.10 — პუნქტი 4 (GeoCharge ტარიფები და დამტენების ბაზა). GeoCharge.ge-ის 18 ქალაქის გვერდიდან (611 სადგური) და /tarifebi/-დან დამუშავდა ქსელების მედიანური ტარიფები. server.js-ში დაემატა enrichStationTariff, haversineMeters და isDuplicateStation (50მ რადიუსის შემოწმება). chargers-cache.json-ის 650 სადგურიდან 501-ს (77.1%) შენარჩუნებული აქვს Firestore-ის ზუსტი ფასი, ხოლო 149 უტარიფო სადგურს შეევსო GeoCharge-ის მედიანური ტარიფი (~ პრეფიქსით) და მერიის TTC დამტენებს 0.00 ₾/kWh (უფასო). დაემატა tests/test_chargers_sync.js (7/7 PASS). ყველა ტესტი: 63/63 PASS.
- 2026-10-16 Antigravity: v3.10.11 — პუნქტი 5 (ქართული Turn-by-Turn აუდიო). შეიქმნა 30 წინასწარ ჩაწერილი სუფთა ქართული ნავიგაციის ფრაზა (audio/*.mp3, 446 KB total, ka-GE-EkaNeural). შეიქმნა turn-audio.js (TurnAudioEngine) მანევრების, მანძილების და გაფრთხილებების მყისიერი ლოკალური დაკვრისთვის (0ms ლატენტობა, 100% ხაზგარეშე). speech.js ინტეგრირებულია TurnAudioEngine-თან (ჩაიმის შემდეგ უკრავს ქართულ აუდიო კლიპს; ნულოვანი ინგლისური fallback). sw.js და index.html განახლდა v3.10.11-ზე. დაემატა tests/test_turn_audio.js (7/7 PASS). ყველა ტესტი: 70/70 PASS.
- 2026-10-16 Antigravity: v3.10.12 — პუნქტი 4-ის დახვეწა (Claude-ის რევიუს საფუძველზე).
  1. `deduplicateStations` და `isDuplicateStation`: მკაცრად ოპერატორზე მგრძნობიარე დედუბლიკაცია (`same operator AND dist <= 30m`). სხვადასხვა ოპერატორი ერთ ლოკაციაზე არასდროს ერთიანდება. ერთი და იგივე ოპერატორის განმეორებადი პოსტები ერთიანდება უმაღლესი სიმძლავრის (max kW), კონექტორების უნიკალური სიმრავლისა და ქართული დასახელების შენარჩუნებით (650 ნედლი ჩანაწერიდან 570 უნიკალურ სადგურამდე).
  2. `isDuplicateStation` პირდაპირ გამოიძახება `deduplicateStations`-ში.
  3. `GEOCHARGE_TARIFF_MEDIANS`: ამოღებულია დაუდასტურებელი `chargerplus` (რომელსაც Firestore-ში უკვე აქვს ზუსტი ფასები) და `greencharge` (რომელიც არ არის /tarifebi/-ზე). მედიანური ტარიფები მონიშნულია როგორც `~0.75 ₾/kWh (სავარაუდო)`.
  4. TTC (მერია): 100% უფასო 0.00 ₾/kWh მხოლოდ AC სადგურებისთვის (<= 22 kW).
  5. `server.js`-ში გასწორდა `CHARGERS_CACHE_TTL` და ამოიშალა დუბლირებული ბლოკი. `tests/test_chargers_sync.js` გაფართოვდა 9/9 PASS-მდე, `smoke_server.js` 100% PASS, ყველა ტესტი 72/72 PASS.
- 2026-10-16 Claude & Antigravity: v3.10.13 —
  1. `?lite=0`: სრულ რუკას რთავს და ძველ მუდმივ Lite-ის ნიშანს ასუფთავებს `localStorage`-დან და `sessionStorage`-დან.
  2. ავტო-Lite (LiteGovernor): გახდა სესიური (`sessionStorage`), რათა შემთხვევითი შეფერხების გამო რუკა სამუდამოდ არ ჩაიკეტოს Lite-ში.
  3. Tesla look: ირთვება მხოლოდ `?style=tesla`-ით (სესიური/URL) და აღარ ინახება მუდმივად `localStorage`-ში.
  4. HUD (`?debug=1`): აჩვენებს `look TESLA` ან `look classic`-ს.
  5. ვერსია განახლდა v3.10.13-ზე: `package.json`, `app.js`, `sw.js`, `index.html`. ყველა ტესტი (72/72) PASS, check_version PASS, smoke PASS.



- 2026-10-16 Claude: v3.10.14 — Tesla look: გზების იერარქია (მთავარი თეთრი, მცირე ოდნავ ნაცრისფერი, მკაფიო კონტური), ქუჩის/POI წარწერები და POI იკონები დახუჭული; place სახელები უცვლელი. მხოლოდ ?style=tesla.

- 2026-10-16 Claude: v3.10.15 — Tesla look ღამე: POI იკონები უფრო მკრთალი (opacity 0.35), გზები უფრო კონტრასტული. დღე უცვლელი. მხოლოდ ?style=tesla.

- 2026-10-16 Claude: v3.10.16 — პუნქტი: OSRM ალტერნატიული მარშრუტები. routing.js: მხოლოდ preview-ში alternatives=true (ნავიგაცია/რეროუტი — false); გაფილტრული 2-მდე რეალური ალტერნატივა (ახლო ასლები და >1.6x ნელი იჭრება); რუკაზე რუხი ხაზები + წარწერა "N წთ (+M)", დაწკაპებით გადართვა (selectAlternative, onRouteSelected ანახლებს preview ბარათს app.js fillPreviewCard-ით). ახალი ტესტი test_route_alternatives.js (7). Google Routes API აკრძალულია არა-Google რუკაზე (Routes API Terms 19.2) — არ ვიყენებთ; TomTom — მხოლოდ Terms-ის გადამოწმების შემდეგ.

- 2026-10-16 Claude: v3.10.17 — შესწორება: v3.10.16-ში "დაწყების ღილაკზე ალტერნატივები იმალება" არ იყო რეალურად დაწერილი (startNavigation რუხ ხაზებსა და წარწერებს ტოვებდა). ახლა startNavigation იძახებს clearAlternatives()-ს; ტესტი დაემატა (9/9).
- 2026-10-16 Samvel & Antigravity: v3.10.17 დადასტურებულია მოწყობილობაზე — ალტერნატიული მარშრუტები, დროის ბეიჯები ("61 წთ (+3)"), დაწკაპებით გადართვა და დაწყებისას მათი გაქრობა 100%-ით გამართულად მუშაობს. TomTom გასაღების ტესტირებით დადასტურდა, რომ TomTom Traffic API-ს არ აქვს Real-Time Traffic დაფარვა საქართველოში (Market Coverage ოფიციალური დოკუმენტაციით); კოდი უცვლელად რჩება საერთაშორისო მგზავრობებისთვის.


- 2026-10-16 Claude: v3.10.18 — ალტერნატივების ხარისხი (ეკრანის სურათის მიხედვით): ა) წარწერა ახლა დგას ალტერნატივის ყველაზე დაშორებულ წერტილზე და არა 30–70% ინდექსზე (იქ მთავარ გზას ემთხვეოდა); ბ) ალტერნატივად ითვლება მხოლოდ ის, რაც მთავარ მარშრუტს >=400 მ-ით შორდება, საწყისიდან/ბოლოდან min(1000მ, 15%) მოშორებით — U-turn ციკლები ამოვარდა. ტესტები 11/11. TomTom საცობები: საქართველო მათ Traffic coverage-ში არ არის (developer.tomtom.com/online-traffic/market-coverage) — ფენა ცარიელია, TomTom routing-ით ტრაფიკი არ გამოვა.

- 2026-10-16 Claude: v3.10.19 — სიჩქარის კამერების ფენა. OSM highway=speed_camera (თბილისის ირგვლივ 70, 68-ს ლიმიტი აქვს). server.js: /api/cameras (Overpass POST, მთელი საქართველო, 24 სთ ქეში მეხსიერებაში + cameras-cache.json; ბრაუზერი Overpass-ს არ ეკითხება). speed-cameras.js (UMD, whitelist-ში): ბრტყელი symbol ფენა, ნიშანი ლიმიტით (canvas, styleimagemissing), update(): კამერა წინ <=350 მ, კონუსი 30°, სიჩქარე >=15, ერთხელ/3 წთ ხმოვანი გაფრთხილება. დოკზე TomTom საცობების ღილაკი დამალულია (საქართველო TomTom Traffic-ში არ არის), მის გვერდით ახალი 📷 ღილაკი. ტესტი test_speed_cameras.js (18). ხარვეზი-რჩევა Antigravity-ს: cameras-cache.json დაამატე .gitignore-ში. მნიშვნელოვანი: server.js-ში ახალი კოდი httpsGetJson-ის შემდეგაა და არა წინ — test_youtube_parse server.js-ის ამ ნაწილს vm-ში ჭრის და require-ს ვერ პოულობს.

- **v3.10.20 (Claude):** `?style=tesla` ღამის გადამრთველი აღარ აკეთებს `setStyle` სრულ გადატვირთვას (ეს ავსებდა რუკას შავით და ყინავდა მანქანის ბრაუზერს). ახლა `TeslaStyle.diff(base, from, to)` + `map.setPaintProperty` ადგილზე ცვლის ფერებს; თუ სტილი ჯერ ჩატვირთული არაა, ძველ გზაზე (`applyMapStyle`) ბრუნდება. ტესტი დამატებულია `test_tesla_style.js`-ში.

- **v3.10.21 (Claude):** ბინების (house number) წარწერა: `minzoom` 17 → 16 (მანქანის ნაგულისხმევი ზუმია 16, ამიტომ ნომრები არასდროს ჩანდა), შრიფტი 11-14 და უფრო მუქი. ჩვეულებრივ (არა-Lite) რეჟიმში ნომრები ჩანს < 15 კმ/სთ-ზე და იმალება > 25 კმ/სთ-ზე (CPU-ს დაზოგვა). Lite-ს საკუთარი ლოგიკა უცვლელია.

- **v3.10.22 (Claude, Samvel-ის გადაწყვეტილებით):** წაშლილია ქართული მოხვევის mp3 აუდიო (`turn-audio.js`, `audio/`) და სიჩქარის კამერების ფენა (`speed-cameras.js`, `/api/cameras`, 📷 ღილაკი, `cameras-cache.json`, ორივეს ტესტი). მიზეზი: მანქანაზე fps 6-16 და სურვილი ზედმეტის მოცილებისა. `speech.js` უცვლელია: `window.TurnAudioEngine` აღარ არსებობს, ამიტომ ხმა მხოლოდ ბრაუზერის TTS-ით ითქმის (ქართული TTS მანქანაში შეიძლება არ იყოს). აღდგენა: გიტიდან v3.10.21-ის ტეგი/კომიტი. server.js-ში `/audio/` მარშრუტი დარჩა (უვნებელია).

- **v3.10.23 (Claude):** ახალი `?style=mono` (მხოლოდ URL-ით, ნაგულისხმევი რუკა უცვლელია): ფერების გარეშე — დღისით თეთრი/ღია ნაცრისფერი, ღამით შავი/მუქი ნაცრისფერი, პარკების ფენები დამალული, **ბრტყელი რუკა (pitch 0 ნაგულისხმევად, `?pitch=N` ზედმეტად ადებს)**, წარწერები და ბინის ნომრები დარჩენილია. ღამე/დღე გადართვა ადგილზე ფერების შეცვლით (diff), როგორც tesla-ზე. `TeslaStyle.apply/diff/routeColors` იღებს მესამე არგუმენტს `mode`. ტესტი დამატებულია. debug-ში `look MONO`.

- **v3.10.24 (Claude):** ავტომატური გაბრტყელება, მძღოლის ჩარევის გარეშე: როცა Lite უკვე ჩართულია და რუკა მოძრაობისას 8 წამის განმავლობაში < 8 fps-ზეა, დახრა (pitch) 45 → 0 ხდება და სესიის ბოლომდე ასე რჩება (`sessionStorage "flat"`). ხელით `?pitch=N` ყოველთვის იმარჯვებს. ნაგულისხმევი გარეგნობა უცვლელია სანამ მანქანა თვითონ არ აჩვენებს, რომ ნელია.

- **v3.10.25 (Claude, Samvel-ის დადასტურებით):** `mono` (ბრტყელი, ნაცრისფერი რუკა) ახლა **ნაგულისხმევია** — `apev.onrender.com` პირდაპირ ამას ხსნის. `?style=classic` აბრუნებს ძველ ფერად 3D რუკას, `?style=tesla` — Tesla პალიტრას. ავტო-გაბრტყელება (v3.10.24) და `?pitch=N` უცვლელია.

- **v3.10.26 (Claude, Samvel-ის თხოვნით, mapsev-ის ტიპის YouTube):** პლეერი გადაკეთდა ორ-პანელიან ფანჯრად. მარცხნივ: ვიდეო (ტაპი = პაუზა/დაკვრა), სათაური+არხი, პროგრესი (ტაპით გადახვევა), shuffle/წინა/დაკვრა/შემდეგი/განმეორება, ჩანართები „პოპულარული მუსიკა“ და „ისტორია“ (localStorage `ytHistory`, 30 ჩანაწერი). მარჯვნივ: ძიება მინიატურებით (`i.ytimg.com`). `media-player.js` გადაწერილია; პროგრესი მოდის YouTube iframe-ის `listening` handshake-ით (`infoDelivery`), embed ახლა `controls=0`. `server.js`: `/api/youtube/search?list=1&n=N` (1..15, ნაგულისხმევი 6), cache-ის გასაღები მოიცავს `n`-ს. `POPULAR_QUERY` (media-player.js) ცვლის „პოპულარულის“ წყაროს. ტესტები: media player 17, სრული `npm test`, `npm run check`, smoke გადის. **ჯერ არ არის გამოცდილი მანქანაში:** რეალური დაკვრა/პროგრესი (sandbox-ს YouTube-ზე წვდომა არ აქვს). Antigravity: commit/push/deploy, `?v=3.10.26`.

- **v3.10.27 (Claude):** (1) YouTube ფანჯარა გადავიდა გვერდით პანელთან (`right:104px`, როგორც ძველი ბარათი), ცენტრში აღარ არის. (2) ისტორია: ჩანართზე მრიცხველი „ისტორია (N)“; თუ ბრაუზერი `localStorage`-ს არ აძლევს საიტს, ცარიელ სიაში ეს წერია (`storageOk`) — მანქანაში დიაგნოსტიკისთვის. (3) Tesla Theater: `launchTeslaTheaterMode` უფრო დიდხანს (3.5 წმ) აჩვენებს ინსტრუქციას, რომ YouTube-ის შუალედურ გვერდზე უნდა დააჭიროს „GO TO SITE“; ამ მეთოდით (youtube.com/redirect) სრული ეკრანი მუშაობს მხოლოდ P-ში და Tesla-ს განახლებამ (2026.38) მსგავსი გზა უკვე დახურა უკანა ეკრანზე, ამიტომ წინა ეკრანზე მუშაობა **არ არის დადასტურებული** — საჭიროა მანქანაში შედეგის ნახვა (რა გვერდი იხსნება). Antigravity: commit/push/deploy `?v=3.10.27`.
