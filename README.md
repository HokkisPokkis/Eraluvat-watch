# Eräluvat kanalintulupavahti

Tämä pieni pilvivahti tarkistaa Eräluvat.fi:n julkisesta saatavuusrajapinnasta Evon ja Vesijaon kanalintuluvat.

Seurattavat kohteet:

- Evo: `areaId 337`, `productId 5`
- Vesijako: `areaId 983`, `productId 5`

Hälytys syntyy, kun minkä tahansa tulevan päivän `available` on suurempi kuin 0. Hälytykseen tulee alue, päivämäärä ja vapaiden lupien määrä.

Ajastettu tiheä seuranta otetaan käyttöön vasta kun repository on public, jotta GitHub Actionsin 5 minuutin ajo ei kuluta private-repositorion maksullisia/minuuttikiintiön ajoja.
