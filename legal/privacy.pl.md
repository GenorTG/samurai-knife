# Polityka prywatności serwisu {{siteName}}

Obowiązuje od: {{effectiveDate}}. Informacje zgodnie z art. 13 i 14 rozporządzenia (UE) 2016/679 („**RODO**”).

## 1. Administrator {#administrator}

Administratorem danych osobowych jest **{{operatorName}}**, {{postalAddress}} („**Operator**”), osoba fizyczna prowadząca serwis {{siteName}} ({{siteUrl}}) prywatnie i niekomercyjnie. Kontakt we wszystkich sprawach dotyczących danych: **{{contactEmail}}**. Operator nie wyznaczył inspektora ochrony danych (nie ma takiego obowiązku).

## 2. Gdzie są Twoje dane {#gdzie}

- Serwis i wszystkie dane Kont są przechowywane na **prywatnym komputerze Operatora w Polsce**, a nie w centrum danych: Operator stosuje zabezpieczenia opisane w pkt 10, ale nie zapewnia ochrony fizycznej i redundancji, jakie daje profesjonalny hosting.
- Pliki Kont (dane CV, dokumenty, rozmowy, szkice, połączenie z repozytorium) są przechowywane **zaszyfrowane** (AES-256-GCM, osobny klucz dla każdego Konta). Klucze API Dostawców AI są zaszyfrowane i nigdy nie są wyświetlane w całości. Klucz szyfrujący znajduje się na tym samym komputerze, więc Operator jako administrator serwera ma techniczną możliwość dostępu do danych. Nie przegląda ich i korzysta z tej możliwości tylko wtedy, gdy wymaga tego rozwiązanie problemu zgłoszonego przez Ciebie, prawo lub bezpieczeństwo Serwisu.
- Poczta wychodząca (potwierdzenia, resetowanie hasła, powiadomienia) jest wysyłana przez serwer pocztowy Operatora i przekaźnik pocztowy u dostawcy **{{mailRelay}}**.
- Kopie zapasowe, o ile są wykonywane, są przechowywane na nośnikach Operatora w Polsce i są nadpisywane po **{{backupRetentionDays}} dniach**.

## 3. Jakie dane, w jakim celu, na jakiej podstawie i jak długo {#dane}

| Dane | Cel | Podstawa (RODO) | Okres przechowywania |
|---|---|---|---|
| Nazwa użytkownika, nazwa wyświetlana, adres e-mail, skrót hasła (scrypt), rola, status, daty utworzenia i ostatniego logowania, limit miejsca, data i wersja akceptacji Regulaminu | założenie i prowadzenie Konta | art. 6 ust. 1 lit. b (umowa) | do usunięcia Konta; rejestracja niepotwierdzona – 24 godziny |
| Sesje logowania (skrót tokenu, daty utworzenia, wygaśnięcia, ostatniego użycia), znacznik zaufanego urządzenia | utrzymanie zalogowania, ochrona przed przejęciem Konta | art. 6 ust. 1 lit. b i f | sesja do 30 dni lub do wylogowania; znacznik urządzenia do 180 dni |
| Treści: profil i wersje CV (także zdjęcie), oferty pracy i aplikacje, dokumenty (z wersjami i koszem), rozmowy z Asystentem AI, postępy w kursie, połączenie ze stroną/repozytorium (repozytorium, gałąź, token, historia audytów), szkice narzędzi | świadczenie usług, o które prosisz | art. 6 ust. 1 lit. b | do usunięcia przez Ciebie lub do usunięcia Konta; kosz dokumentów – 30 dni |
| Konfiguracja Dostawcy AI (adres, model, zaszyfrowany klucz API), klucze MCP (wyłącznie skróty) | Asystent AI i dostęp Twoich programów do Konta | art. 6 ust. 1 lit. b | do zmiany, unieważnienia klucza lub usunięcia Konta |
| Liczniki użycia (np. liczba tokenów modelu) | uczciwy podział zasobów, limity | art. 6 ust. 1 lit. b i f | do usunięcia Konta |
| Dane z GitHub przy logowaniu przez GitHub: identyfikator i login GitHub, imię i nazwisko z profilu, zweryfikowany adres e-mail; lista instalacji i repozytoriów, do których masz dostęp | logowanie, łączenie Konta, studio stron | art. 6 ust. 1 lit. b | do odłączenia GitHub lub usunięcia Konta |
| Zdarzenia bezpieczeństwa: rodzaj zdarzenia, nazwa Konta, adres IP (dla IPv6 – prefiks /64), czas | bezpieczeństwo Serwisu, wykrywanie nadużyć i ataków | art. 6 ust. 1 lit. f (prawnie uzasadniony interes: bezpieczeństwo sieci i informacji, motyw 49 RODO) | 30 dni |
| Liczniki limitów i blokad (adres IP, liczba żądań) | ochrona przed przeciążeniem i nadużyciami | art. 6 ust. 1 lit. f | w pamięci serwera, od minut do godzin |
| Dzienniki techniczne serwera, serwera pocztowego i serwera pośredniczącego (adres IP, czas, adres strony, przeglądarka, status; przy poczcie – adres odbiorcy i status doręczenia) | działanie i bezpieczeństwo Serwisu, usuwanie awarii | art. 6 ust. 1 lit. f | do {{logRetentionDays}} dni |
| Wiadomości e-mail wysyłane do Ciebie i ich treść | potwierdzenie adresu, reset hasła, powiadomienia o bezpieczeństwie i zmianach | art. 6 ust. 1 lit. b i f | dzienniki doręczeń jak wyżej; adres, na który poczta nie dochodzi, jest blokowany na 30 dni (zapisywany wyłącznie jako skrót) |
| Korespondencja z Operatorem, reklamacje, zgłoszenia nielegalnych treści | obsługa spraw, obowiązki z DSA, obrona przed roszczeniami | art. 6 ust. 1 lit. c (DSA) i f | do zakończenia sprawy, a potem do przedawnienia roszczeń |
| Adresy stron podane do pobrania (oferty pracy, strony firm) lub audytu | wykonanie żądanej funkcji | art. 6 ust. 1 lit. b | razem z ofertą lub historią audytów |

Operator nie korzysta z Twoich danych do marketingu, profilowania ani trenowania modeli AI i nikomu ich nie sprzedaje. Z narzędzi działających w przeglądarce dane trafiają na serwer tylko wtedy, gdy narzędzie musi wykonać obliczenia na serwerze (np. OCR); pliki robocze są usuwane po zakończeniu zadania.

## 4. Odbiorcy danych {#odbiorcy}

- **{{mailRelay}}** – dostawca serwera wirtualnego, przez który wychodzi poczta; przetwarza dane w imieniu Operatora (podmiot przetwarzający, art. 28 RODO).
- **Dostawca AI, którego wybrałeś** – gdy korzystasz z Asystenta AI, Serwis przesyła na Twoje polecenie treść rozmowy i dane z otwartych narzędzi do adresu skonfigurowanego na Twoim Koncie. Dostawca przetwarza je na podstawie **Twojej umowy z nim** i własnej polityki prywatności, a nie na zlecenie Operatora. Nie wysyłaj tam danych innych osób, do których udostępnienia nie masz prawa.
- **GitHub, Inc.** (USA) – przy logowaniu przez GitHub i pracy z repozytorium; GitHub działa jako niezależny administrator danych w Twoim koncie GitHub ([polityka prywatności GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)).
- **Google LLC** (USA) – przy audycie strony usługą PageSpeed Insights trafia tam adres audytowanej strony (z serwera Operatora, bez Twojego adresu IP).
- **Strony, które wskazujesz** (oferty pracy, strony firm, audytowane witryny) – widzą jedynie adres IP serwera Operatora.
- Organy publiczne – wyłącznie gdy wymaga tego prawo.

## 5. Przekazywanie danych poza Europejski Obszar Gospodarczy {#transfer}

GitHub i Google mają siedzibę w USA. Przekazywanie opiera się na decyzji Komisji Europejskiej (UE) 2023/1795 w sprawie ram ochrony danych UE–USA (Data Privacy Framework), jeżeli odbiorca jest nimi objęty, a w pozostałych przypadkach na standardowych klauzulach umownych. Jeżeli wybrany przez Ciebie Dostawca AI ma siedzibę poza EOG, przesyłanie do niego jest niezbędne do wykonania usługi, o którą prosisz (art. 49 ust. 1 lit. b RODO), a dalsze przetwarzanie reguluje Twoja umowa z nim.

## 6. Pliki cookie i pamięć przeglądarki {#cookies}

Serwis zapisuje na Twoim urządzeniu wyłącznie informacje **niezbędne do świadczenia usługi, o którą prosisz** (art. 399 ust. 3 ustawy – Prawo komunikacji elektronicznej), dlatego nie prosi o zgodę. Nie ma analityki, reklam ani skryptów zewnętrznych.

| Nazwa | Rodzaj | Cel | Czas |
|---|---|---|---|
| `knife_session` | cookie | zalogowanie | do 30 dni |
| `knife_device` | cookie | rozpoznanie urządzenia, na którym już się logowałeś (ochrona przed przejęciem Konta) | do 180 dni |
| `knife_gh_state` | cookie | zabezpieczenie logowania przez GitHub | 10 minut |
| `sk-theme`, ustawienia narzędzi | pamięć lokalna | jasny lub ciemny motyw, Twoje ustawienia narzędzi | do usunięcia w przeglądarce |
| kopia rozmowy z Asystentem, kolejka wiadomości, tryb zaufania, ustawienia SQL | pamięć lokalna | działanie Asystenta i narzędzi bez ponownego pobierania | usuwane przy wylogowaniu |

Możesz usunąć te dane w ustawieniach przeglądarki; bez cookie sesji nie da się zalogować.

## 7. Twoje prawa {#prawa}

Masz prawo do: dostępu do danych i otrzymania ich kopii, sprostowania, usunięcia, ograniczenia przetwarzania, przenoszenia danych oraz **sprzeciwu** wobec przetwarzania opartego na prawnie uzasadnionym interesie (art. 15–21 RODO). Konto i wszystkie jego dane usuniesz sam w ustawieniach Konta; pozostałe żądania wyślij na adres {{contactEmail}}. Operator odpowiada bez zbędnej zwłoki, najpóźniej w ciągu miesiąca.

## 8. Skarga do organu nadzorczego {#skarga}

Masz prawo wnieść skargę do **Prezesa Urzędu Ochrony Danych Osobowych**, ul. Stanisława Moniuszki 1A, 00-014 Warszawa ([uodo.gov.pl](https://uodo.gov.pl)).

## 9. Czy musisz podać dane {#wymog}

Podanie nazwy użytkownika, adresu e-mail i hasła (albo zalogowanie przez GitHub) jest warunkiem założenia Konta. Pozostałe dane podajesz dobrowolnie, korzystając z wybranych funkcji; klucz API Dostawcy AI jest potrzebny tylko do Asystenta AI.

## 10. Bezpieczeństwo i naruszenia {#bezpieczenstwo}

Połączenia są szyfrowane (HTTPS), pliki Kont i klucze API są zaszyfrowane, hasła są przechowywane jako skróty, serwer jest chroniony zaporą i limitami, a narzędzia przetwarzające pliki działają w odizolowanym środowisku (sandbox). Jeżeli dojdzie do naruszenia ochrony danych, Operator zgłosi je Prezesowi UODO w ciągu 72 godzin, gdy jest to wymagane, a w razie wysokiego ryzyka niezwłocznie poinformuje Ciebie.

## 11. Zautomatyzowane decyzje {#decyzje}

Operator nie podejmuje decyzji opartych wyłącznie na zautomatyzowanym przetwarzaniu, w tym profilowaniu, które wywołują wobec Ciebie skutki prawne lub w podobny sposób istotnie na Ciebie wpływają. Automatyczne limity i blokady chroniące przed nadużyciami są tymczasowe i nie oceniają Twojej osoby.

## 12. Wiek {#wiek}

Serwis jest przeznaczony dla osób, które ukończyły {{minimumAge}} lat.

## 13. Dane szczególne i dane innych osób {#szczegolne}

CV może zawierać dane szczególnych kategorii (np. o zdrowiu lub niepełnosprawności) i dane innych osób (np. referencje). Zapisuj je tylko wtedy, gdy to potrzebne i masz do tego prawo.

## 14. Zmiany {#zmiany}

O istotnych zmianach tej Polityki Operator informuje e-mailem i w Serwisie, tak jak o zmianach Regulaminu.
