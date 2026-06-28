# Napojenie ledgeru do servera — runbook

Cieľ: nahradiť terajšie „credits" v `server.js` ozajstným double-entry ledgerom
(`ledger.js` + `ledger_schema.sql`), bez straty zostatkov a bez výpadku appky.

> **Stav:** ledger + migrácia sú hotové a otestované (`npm run test:ledger`,
> `npm run test:migrate`). Tento dokument je plán toho, čo ešte treba spraviť v
> `server.js`, a **bezpečný postup nasadenia naostro**.

---

## 1. Čo sa mení v `server.js` (mapovanie)

Terajšia logika drží peniaze ako `user.credits` v jednom JSON blobe a mutuje ich
priamo. Po napojení sa každá peňažná operácia presmeruje na ledger:

| Terajšie (credits v blobe) | Nové (ledger.js) |
|---|---|
| `u.credits -= total+fee` pri vytvorení dare | `fundDare(client, { code, creatorId, reward, maxWinners })` |
| `w.credits += payout` pri schválení | `approveSubmission(client, submissionId)` |
| refund pri delete/expirácii | `refundDare(client, dareId)` |
| `tu.credits = v` (admin set) | samostatná `admin-adjust` tx (ext↔user) — radšej obmedz |
| zobrazenie zostatku | `balanceOf(client, 'user', userId)` |
| (nové) vklad / výber | `deposit(...)` / `withdraw(...)` po on-chain potvrdení |

Dôležité technické body:
- **Postgres tabuľky namiesto blobu pre peniaze.** Spusti `ledger_schema.sql` pri
  štarte (idempotentné `CREATE TABLE IF NOT EXISTS`).
- **Jeden vyhradený `pg` client na request** (nie pool.query) — všetky funkcie bežia
  cez `BEGIN/COMMIT`, takže musia ostať na jednom spojení. Vzor:
  ```js
  const client = await pool.connect();
  try { const r = await fundDare(client, {...}); }
  finally { client.release(); }
  ```
- **Sumy v micro-jednotkách** (1 USDT = 1 000 000). Na vstupe z UI prenásob, na
  výstupe vyděl.

---

## 2. Migrácia existujúceho stavu

`migrate_to_ledger.mjs` vezme terajší `app_state` (JSON blob z Postgresu alebo
`data.json`) a spraví z neho ledger:

- každému užívateľovi vytvorí **otváraciu bilanciu** = jeho terajšie `credits`,
- z **nezaplatených slotov** otvorených dares zrekonštruuje zamknutý escrow,
- historické poplatky zaeviduje ako príjem,
- znova vytvorí riadky `dares` a `submissions`.

Je **idempotentná** (marker tabuľka `migrations` — odmietne sa spustiť druhýkrát) a
beží v jednej transakcii (všetko alebo nič). Overené testom: zostatky sedia na cent,
escrow sedí, konzervácia = 0 a migrovaný stav je hneď použiteľný.

---

## 3. Bezpečné nasadenie naostro (poradie!)

1. **Záloha.** V Railway sprav backup Postgresu (Postgres service → Backups). Bez
   zálohy nepokračuj.
2. **Vytiahni si terajší `app_state`** (SELECT z tabuľky `app_state`) do súboru —
   to je vstup pre migráciu a zároveň druhá záloha.
3. **Nasaď kód** so schémou + migráciou spustenou raz pri štarte (za feature-flagom
   `LEDGER=1`), alebo migráciu spusti samostatným skriptom proti produkčnej DB.
4. **Over invarianty** hneď po migrácii: `totalConservation == 0`, `reconcile == []`,
   a náhodne skontroluj 2–3 užívateľov, či `balanceOf` == ich pôvodné credits.
5. **Prepni** appku na čítanie/zápis cez ledger (flag).
6. **Sleduj** prvých pár operácií (vytvorenie dare, schválenie) v logoch.

### Rollback
- Ak niečo nesedí pred krokom 5, **neprepínaj** — appka stále beží na starom blobe.
- Ak už po prepnutí: vráť feature-flag späť na blob a obnov Postgres zo zálohy z
  kroku 1. Preto je marker `migrations` dôležitý — po rollbacku ho zmaž, nech sa dá
  migrácia spustiť nanovo po oprave.

---

## 4. Prečo to robíme cez vetvu, nie rovno do `main`

`main` sa automaticky deployuje na Railway. Preto samotný **prepis `server.js`**
(veľká zmena živej peňažnej logiky) sprav na vetve `ledger-integration`, otestuj, a
do `main` zlej až keď je migrácia overená a máš zálohu. Ledger, migrácia a tento
runbook sú aditívne (server ich zatiaľ neimportuje), takže môžu byť v `main` bez rizika.

---

## 5. Súbory

| Súbor | Rola |
|---|---|
| `ledger_schema.sql` | tabuľky |
| `ledger.js` | ledger + stavový automat (atomické, anti-cheat) |
| `migrate_to_ledger.mjs` | jednorazová migrácia blob → ledger |
| `test_ledger.mjs`, `test_migrate.mjs` | testy (spolu 38, všetky zelené) |

Ďalší krok: prepísať peňažné endpointy v `server.js` podľa mapovania z §1 — spravím
na vetve `ledger-integration`, keď povieš.
