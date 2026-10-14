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
| `media-player.js`, YouTube-ის HTML/CSS, `sim-drive.js`, `tests/test_sim_drive.js` | Antigravity |
| `index.html`, `package.json`, `server.js` | საერთო: ცვლილებამდე წაიკითხე და ჩაწერე აქ |

## რუკის მიმდინარე სტატუსი (v3.10.2)
- რუკა: MapLibre GL + OpenFreeMap (3D ვექტორული), კამერა `map-gl.js`-ში.
- **ისრის გადასვლის Root Cause მოგვარებულია:** MapLibre-ში `jumpTo`-ს გამოძახებისას შიგნიდან ისროლებოდა `rotatestart` და `pitchstart` ივენთები (სადაც `e.originalEvent` არ არსებობს). ძველი კოდი ამას მძღოლის ჟესტად აღიქვამდა და პირველივე ფრეიმზე თიშავდა მიყოლას (`setFollowCarMode(false)`). ფილტრით `if (e && e.originalEvent && !e.followCamera)` კამერის შიდა მოძრაობები აღარ თიშავს მიყოლას.
- `map-gl.js`-ში აღდგა `recenter(coords, bearing, pitch)` და `_easingUntil`.
- დამატებულია Claude-ის დიაგნოსტიკის პანელი (სიჩქარეზე 5 დაჭერა ან `?debug=1`), რომელიც ძალიან გამოსადეგია.
- რუკის არჩევის მენიუში მხოლოდ ვექტორული რუკაა. Google გზების რუკა საგანგებო ვარიანტია.
- **ტესტ-დრაივი / სიმულაცია (`sim-drive.js`):** დაემატა `#btn-sim-drive` ღილაკი პანელზე. საშუალებას აძლევს მძღოლს მანქანის გაჩერებულ მდგომარეობაში შეამოწმოს რუკის მოძრაობა, კამერის მიყოლა (45° Heading-Up), შუქნიშნები და მოხვევები.

## YouTube მედია პლეიერის სტატუსი (v3.10.2)
- დაემატა Playlist Queue და ავტომატური შემდეგი (Auto-Advance): ვიდეოს დასრულებისას (`YT.PlayerState.ENDED`) პლეიერი ავტომატურად გადადის შემდეგ ჩანაწერზე.
- დაემატა სენსორული მართვის ზოლი: `⏮️`, `⏯️`, `⏭️`, `🔂` (Loop) და მიმდინარე ტრეკის სათაური.
- შეიქმნა ავტომატური ტესტები `tests/test_media_player.js` (7/7 PASS).

## მოთხოვნები (ერთმანეთისთვის)
- Claude: `tests/test_map_gl.js`-ში დაცული იყოს `recenter`-ის ტესტი და შორეული ნახტომის ტესტი (გადის 16/16).
- Antigravity: YouTube პლეიერის ცვლილებები დაცულია `media-player.js`-ში, ტესტ-დრაივის სიმულატორი იზოლირებულია `sim-drive.js`-ში.

## ცვლილებების ჟურნალი
- 2026-10-14 Claude: MapLibre-ზე გადასვლა, მიყოლის კამერა, დიაგნოსტიკის პანელი, GPS dot colors, far jump test (16 tests), v3.10.2.
- 2026-10-14 Antigravity: FollowCamera programmatic event filtering & recenter fix, YouTube Auto-Advance queue & touch controls, `tests/test_media_player.js`, style synchronization, v3.10.2.
- 2026-10-14 Antigravity: Added Test Drive simulation (`sim-drive.js`), `#btn-sim-drive` on dock, `tests/test_sim_drive.js` (5/5 PASS), v3.10.2.



