# TON (testnet) — vklady a výbery USDT

Tento modul napája `deposit()` / `withdraw()` ledgeru na reálny TON reťazec.
**Začni na testnete.** Pri `LEDGER=1` server pri štarte spustí sledovanie vkladov.

## Ako to funguje

**Vklad (bezpečné, len čítanie z reťazca):**
1. Používateľ pošle USDT (jetton) na `DEPOSIT_ADDRESS` a do **komentára** dá svoj `@username`.
2. `startDepositWatcher` každých ~30 s číta cez toncenter prichádzajúce transfery.
3. `creditConfirmedDeposit` pripíše sumu do ledgeru — **idempotentne**: ten istý
   on-chain `tx hash` pripíše **nanajvýš raz** (chráni aj unikátny index v DB).

**Výber (citlivé — podpisuje sa tvojím kľúčom):**
- `sendUsdt({ toAddress, amountUsdt })` podpíše a odošle USDT zo servera pomocou
  `WALLET_MNEMONIC`. **Túto premennú nastavuješ TY a nikdy ju nikomu nedávaš.**
- Odporúčaný bezpečný tok: používateľ požiada o výber → operátor (ty) odošle on-chain →
  až po úspechu sa zavolá ledgerový `withdraw` (debetuje zostatok). Neautomatizuj
  posielanie z hot walletu bez limitov a kontroly.

## Premenné prostredia (Railway)

| Premenná | Príklad / poznámka |
|---|---|
| `LEDGER` | `1` (zapne ledger + watcher) |
| `TON_NETWORK` | `testnet` (potom `mainnet`) |
| `TON_API` | voliteľné; default toncenter podľa siete |
| `TON_API_KEY` | API kľúč z @toncenter botom (odporúčané kvôli limitom) |
| `DEPOSIT_ADDRESS` | adresa peňaženky, kam chodia vklady |
| `USDT_JETTON_MASTER` | jetton master USDT na danej sieti |
| `WALLET_MNEMONIC` | 24 slov hot walletu — **tajné, len pre výbery** |
| `USDT_DECIMALS` | `6` |

## Postup na testnete

1. Vytvor si testnet peňaženku, načerpaj test TON (faucet) a test USDT jetton.
2. Nastav premenné vyššie (okrem `WALLET_MNEMONIC`, ak zatiaľ netestuješ výbery).
3. Pošli malý vklad s komentárom = svoj username, počkaj na potvrdenie.
4. Skontroluj logy: `deposit X USDT -> @ty (txhash…)` a zostatok v appke.
5. **Over polia odpovede toncenteru** — ak sa líšia, uprav picky v `pollDeposits`
   (`transaction_hash`, `forward_payload`, `amount`). Toto je jediná časť, ktorú
   som nemohol overiť bez tvojej testnet peňaženky.

## Bezpečnosť (zhrnutie)
- Hot wallet drž s minimom prostriedkov; väčšinu v cold storage.
- `WALLET_MNEMONIC` nikdy necommituj ani nezdieľaj (je v `.gitignore` cez `.env`).
- Pred mainnetom: limity na výbery, manuálne schválenie väčších súm, rekonciliácia
  on-chain zostatok vs `liabilities()`.

## Test
`npm run test:ton` — overuje idempotentné pripísanie vkladu a dekódovanie komentára
(bez siete, cez PGlite). 11/11.
