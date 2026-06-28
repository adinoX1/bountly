# Bountly — escrow & platby (návrh)

Cieľ: reálne peniaze (krypto) v escrow tak, aby to **nikto neojebal** — ani creator,
ani hunter, ani omylom samotná platforma. Tento dokument vysvetľuje model, na ktorom
stojí priložený kód (`ledger_schema.sql`, `ledger.js`, `test_ledger.mjs`).

Zvolené smerovanie (z našej dohody): **custodial** (platforma drží prostriedky),
**admin ako rozhodca**, mena **USDT (stablecoin)**, rail **TON** (natívny pre Telegram).

---

## 1. Kľúčová myšlienka: dva oddelené problémy

1. **Úschova peňazí** — rieši **double-entry ledger** (účtovníctvo). Peniaze sa nedajú
   v systéme vytvoriť ani zničiť, len presunúť. Toto je matematicky ustrážené.
2. **Rozhodnutie o platnosti dôkazu** — toto ledger nevyrieši, je to ľudský/oracle
   problém. Rieši ho **admin ako rozhodca** + poistky (time-lock, stake, odvolanie).
   Tu treba sústrediť anti-abuse úsilie.

Tento balík rieši **bod 1 kompletne a dokázateľne**. Bod 2 je proces, nie kód.

---

## 2. Double-entry ledger (jadro)

Žiadne `float`. Sumy sú celé čísla v **micro-jednotkách** (1 USDT = 1 000 000).

Každý pohyb peňazí je **transakcia** zložená z 2+ položiek, ktorých súčet je **vždy
presne 0**. Peniaze teda nikdy nepribudnú ani nezmiznú — iba sa presúvajú medzi účtami.

Typy účtov:

| Účet | Význam |
|------|--------|
| `user:<id>` | zostatok hráča (záväzok — dlhujeme mu ho) |
| `escrow` | prostriedky zamknuté za otvorené dares (záväzok) |
| `platform_fees` | naše príjmy z poplatkov |
| `external` | „vonkajší svet" / blockchain (kontra-účet) |

Príklady transakcií (všetky sčítajú na 0):

- **Vklad** (po potvrdení on-chain): `external −X`, `user +X`
- **Vytvorenie dare**: `creator −(odmena·výhercovia + fee)`, `escrow +odmena·výhercovia`, `platform_fees +fee`
- **Výplata výhercu**: `escrow −odmena`, `winner +(odmena − player fee)`, `platform_fees +player fee`
- **Refund** (zrušenie/expirácia): `escrow −zostatok`, `creator +zostatok`
- **Výber**: `user −X`, `external +X`

---

## 3. Prečo sa to nedá ojebať (vynútené v `postTx`)

Každý pohyb ide cez jednu funkciu `postTx()`, ktorá:

1. **Zamkne dotknuté účty** (`SELECT … FOR UPDATE`) → dve súčasné požiadavky sa
   nemôžu pretekať na tom istom zostatku (žiadne race conditiony).
2. **Odmietne transakciu, ktorá nesčíta na 0** → nedá sa „vyrobiť" hodnota.
3. **Nedovolí účtu `user` ani `escrow` ísť do mínusu** → žiadne prečerpanie, nedá sa
   vyplatiť z escrow viac, než tam je.

Z toho **priamo vyplýva**, že tieto útoky sú nemožné (overené testami):

- vyplatiť výhercovi viac, než dare zamkol,
- vyplatiť ten istý slot/submission dvakrát,
- schváliť viac výhercov, než je slotov,
- vytvoriť dare bez dostatku kreditu,
- vybrať viac, než má užívateľ.

Každá takáto operácia spadne a **celá transakcia sa odroluje** (atomicita) — žiadny
čiastočný presun peňazí.

### Kontroly integrity (na monitoring)
- `totalConservation` — súčet všetkých zostatkov musí byť **0**.
- `reconcile` — cachované zostatky sa musia rovnať žurnálu (žiadny drift).
- `liabilities` — koľko reálne dlhujeme (`user + escrow`); **reálna rezerva on-chain
  musí byť vždy ≥ tomuto číslu**.

---

## 4. Stavový automat dare

```
            fundDare()                 approve (posledný slot)
   [créda] ─────────────► OPEN ───────────────────────────► CLOSED
                           │  ▲  │
            approve(slot)  │  │  │ submitProof()
            (escrow−odmena)│  │  └────────────────┐
                           │  └── stále sú sloty   │
                           ▼                        │
                        refundDare()  ──────────► CANCELLED
                        (escrow→creator)
```

- `escrow_locked` daného dare iba **klesá** (výplata) alebo sa **vráti na 0** (refund).
- Creator **nikdy nie je sudcom** svojho dare (inak by nezaplatil platný dôkaz).
- Pri expirácii/zrušení sa nevyčerpaný escrow **automaticky vracia** creatorovi.

---

## 5. Custodial prevádzka — čo musíš ustrážiť TY

Pri custody sa „ojeb plocha" presúva na prevádzku. Nutné minimum:

- **Kreditovať vklad až po potvrdení on-chain** (počet confirmations, overená suma,
  pozor na reorg). Nikdy nie na základe „user povedal, že poslal".
- **Hot/cold split**: väčšina prostriedkov v cold wallet, len malý prevádzkový float
  v hot wallet. Privátny kľúč custodial peňaženky = najcennejšia vec.
- **Rezerva ≥ záväzky vždy.** Pravidelná rekonciliácia: on-chain zostatok vs
  `liabilities()`. Ak by rezerva klesla pod záväzky, okamžite zastav výbery.
- **Výbery**: limity, manuálna kontrola väčších súm, 2FA, denný strop.
- **Idempotencia vkladov**: každý on-chain `txhash` spracuj **iba raz** (uložiť do
  `ledger_tx.ref` + unique, aby sa dvojitý webhook nezakreditoval dvakrát).

> ⚖️ **Právne**: custodial držanie cudzieho krypta je v mnohých jurisdikciách
> *money transmitter / custody* → licencie, KYC/AML. Toto over s právnikom skôr, než
> pustíš reálne peniaze. Je to väčší risk ako akýkoľvek bug v kóde.

---

## 6. TON + USDT integrácia (ďalší krok)

1. **Vklady**: pre každého usera odvodená deposit adresa (alebo jedna spoločná adresa
   s `memo`/comment = userId). Sleduj prichádzajúce **USDT jetton** transfery cez TON
   API (toncenter / TON Connect). Po N potvrdeniach zavolaj `deposit(db, userId, amount, txhash)`.
2. **Výbery**: user zadá svoju TON adresu → ty po manuálnej/limit kontrole pošleš USDT
   z hot walletu → **až po úspešnom on-chain odoslaní** zavolaj `withdraw(...)`.
3. **Vytvorenie dare / výplata / refund** sú čisto interné ledger operácie (žiadny
   on-chain pohyb), takže sú okamžité a bez gas poplatkov. On-chain ide len vklad a výber.

Najprv **TON testnet** + falošné USDT, kým to celé neodladíme a nemáš právne jasno.

---

## 7. Priložené súbory

| Súbor | Obsah |
|-------|-------|
| `ledger_schema.sql` | Postgres schéma (účty, žurnál, dares, submissions) |
| `ledger.js` | ledger + stavový automat (atomické transakcie, zámky, anti-overdraw) |
| `test_ledger.mjs` | 22 testov vrátane pokusov o podvod — všetky prechádzajú |

Spustenie testov: `npm run test:ledger` (beží na PGlite — reálny Postgres, netreba
server). Toto je zatiaľ **samostatný základ** — do `server.js` ho napojíme, keď
povieš, že model sedí.
