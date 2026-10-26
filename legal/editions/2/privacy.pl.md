# Polityka prywatności serwisu {{siteName}}

Obowiązuje od: {{effectiveDate}}. Informacje zgodnie z art. 13 i 14 rozporządzenia (UE) 2016/679 („**RODO**”). Zmiany względem poprzedniej wersji: pkt 15.

## 1. Administrator {#administrator}

Administratorem danych osobowych jest **{{operatorName}}**, {{postalAddress}} („**Operator**”), osoba fizyczna prowadząca serwis {{siteName}} ({{siteUrl}}) prywatnie i niekomercyjnie. Kontakt we wszystkich sprawach dotyczących danych: **{{contactEmail}}**. Operator nie wyznaczył inspektora ochrony danych (nie ma takiego obowiązku).

## 2. Gdzie są Twoje dane {#gdzie}

- Serwis i wszystkie dane Kont są przechowywane na **prywatnym komputerze Operatora w Polsce**, a nie w centrum danych: Operator stosuje zabezpieczenia opisane w pkt 10, ale nie zapewnia ochrony fizycznej i redundancji, jakie daje profesjonalny hosting.
- Pliki Kont (dane CV, dokumenty, pliki zapisane z aplikacji Craft, rozmowy, szkice, przepływy pracy wraz z historią uruchomień i danymi uwierzytelniającymi, połączenie z repozytorium) są przechowywane **zaszyfrowane** (AES-256-GCM, osobny klucz dla każdego Konta). Klucze API Dostawców AI i dane uwierzytelniające przepływów są zaszyfrowane i po zapisaniu nigdy nie są ponownie wyświetlane w całości. Klucz szyfrujący znajduje się na tym samym komputerze, więc Operator jako administrator serwera ma techniczną możliwość dostępu do danych. Nie przegląda ich i korzysta z tej możliwości tylko wtedy, gdy wymaga tego rozwiązanie problemu zgłoszonego przez Ciebie, prawo lub bezpieczeństwo Serwisu.
- **Przepływy pracy** (workflows) działają na serwerze Operatora, każde uruchomienie w osobnym, odizolowanym procesie. Przepływ wysyła dane tylko tam, gdzie wskazują jego węzły: na adresy i do usług, które w nim wpisałeś (np. żądanie HTTP lub integracja), z użyciem zapisanych przez Ciebie danych uwierzytelniających, oraz do Dostawcy AI węzła AI. Ci odbiorcy działają w ramach Twojej relacji z nimi (pkt 4).
- **Aplikacje Craft** (jeżeli ta instancja je udostępnia): programy open source zespołu ArtCraft (PhotoCraft, VectorCraft, FilmCraft i inne), które Operator udostępnia bez zmian z własnego serwera, pod osobnym adresem. Działają w całości w Twojej przeglądarce: Twoja praca zostaje w pamięci przeglądarki dla tego adresu (pkt 6), dopóki nie zapiszesz jej na Koncie jako pliku Craft. Nic nie jest wysyłane do zespołu ArtCraft. Aby aplikacje były aktualne, serwer pyta GitHub o ich nowe wydania; te zapytania nie zawierają żadnych danych o Tobie.
- **{{mailRelay}}** jest używany wyłącznie jako przekaźnik poczty wychodzącej z Serwisu — nie hostuje Kont ani pozostałych danych Serwisu. Przekazywane są do niego adres odbiorcy oraz treść wygenerowanej przez Serwis wiadomości transakcyjnej (np. nazwa Konta lub jednorazowy link potwierdzający/resetujący, zależnie od wiadomości) i niezbędne metadane doręczenia. Nie są tam wysyłane CV, dokumenty, rozmowy z Asystentem ani inne treści Konta. Połączenie z przekaźnikiem jest zawsze szyfrowane (TLS), a dalej do serwera pocztowego odbiorcy – jeżeli ten serwer to obsługuje. Przekaźnik nie przechowuje wiadomości po ich doręczeniu; jego dziennik zawiera adres odbiorcy, czas i status doręczenia (bez tematu i treści) i jest usuwany po {{logRetentionDays}} dniach.
- Kopie zapasowe, o ile są wykonywane, są przechowywane na nośnikach Operatora w Polsce i są nadpisywane po **{{backupRetentionDays}} dniach**. Dane, które usuniesz (także razem z Kontem), znikają z kopii zapasowych najpóźniej po tym czasie; do tego czasu kopie nie są używane do niczego poza odtworzeniem Serwisu po awarii.

## 3. Jakie dane, w jakim celu, na jakiej podstawie i jak długo {#dane}

| Dane | Cel | Podstawa (RODO) | Okres przechowywania |
|---|---|---|---|
| Nazwa użytkownika, nazwa wyświetlana, adres e-mail, skrót hasła (scrypt), rola, status, daty utworzenia i ostatniego logowania, limit miejsca, data i wersja akceptacji Regulaminu | założenie i prowadzenie Konta | art. 6 ust. 1 lit. b (umowa) | do usunięcia Konta; rejestracja niepotwierdzona – 24 godziny |
| Sesje logowania (skrót tokenu, daty utworzenia, wygaśnięcia, ostatniego użycia), znacznik zaufanego urządzenia | utrzymanie zalogowania, ochrona przed przejęciem Konta | art. 6 ust. 1 lit. b i f | sesja do 30 dni lub do wylogowania; znacznik urządzenia do 180 dni |
| Treści: profil i wersje CV (także zdjęcie), oferty pracy i aplikacje, dokumenty (z wersjami i koszem), pliki zapisane z aplikacji Craft, rozmowy z Asystentem AI, postępy w kursie, połączenie ze stroną/repozytorium (repozytorium, gałąź, token, historia audytów), szkice narzędzi | świadczenie usług, o które prosisz | art. 6 ust. 1 lit. b | do usunięcia przez Ciebie lub do usunięcia Konta; kosz dokumentów – 30 dni |
| Przepływy pracy: ich węzły, ustawienia, wyzwalacze (harmonogramy, adresy webhook) i notatki; tabele danych i dane zachowywane przez przepływ między uruchomieniami (np. pamięć agenta AI, już widziane elementy); linki wznowienia oczekujących uruchomień | wykonywanie automatyzacji, które budujesz | art. 6 ust. 1 lit. b | do usunięcia przepływu lub Konta |
| Historia uruchomień przepływów: kiedy i jak uruchomienie się zaczęło, dane wejściowe i wyjściowe każdego węzła (skracane przy dużych wynikach), błędy, czas trwania | pokazanie Ci, co zrobiły Twoje przepływy, szukanie błędów | art. 6 ust. 1 lit. b | ostatnie 100 uruchomień każdego przepływu, najdłużej 14 dni; możesz usunąć je wcześniej |
| Dane uwierzytelniające przepływów: nazwa, rodzaj i sekrety (klucze API, hasła, tokeny, identyfikator i sekret zarejestrowanych przez Ciebie aplikacji OAuth, tokeny wydane przez te aplikacje) | umożliwienie przepływom dostępu do wybranych przez Ciebie usług | art. 6 ust. 1 lit. b | do usunięcia danych uwierzytelniających lub Konta; przekazywane uruchomieniu tylko dla węzłów, które z nich korzystają |
| Żądania wysłane na adresy webhook Twoich przepływów: nagłówki (w tym adres IP i przeglądarka wywołującego przekazane przez serwer pośredniczący; pliki cookie są usuwane), parametry adresu, treść i pliki | uruchomienie przepływu z danymi przesłanymi przez wywołującego | wobec Ciebie art. 6 ust. 1 lit. b; wobec wywołującego art. 6 ust. 1 lit. f (świadczenie usługi skonfigurowanej przez Użytkownika) | jak historia uruchomień |
| Konfiguracja Dostawcy AI (jeden lub kilka nazwanych profili: adres, model, zaszyfrowany klucz API), klucze MCP (wyłącznie skróty) | Asystent AI, węzły AI w przepływach i dostęp Twoich programów do Konta | art. 6 ust. 1 lit. b | do zmiany, unieważnienia klucza lub usunięcia Konta |
| Liczniki użycia (np. liczba tokenów modelu zużytych przez Asystenta i węzły AI) | uczciwy podział zasobów, limity | art. 6 ust. 1 lit. b i f | do usunięcia Konta |
| Dane z GitHub przy logowaniu przez GitHub: identyfikator i login GitHub, imię i nazwisko z profilu, zweryfikowany adres e-mail; lista instalacji i repozytoriów, do których masz dostęp | logowanie, łączenie Konta, studio stron | art. 6 ust. 1 lit. b | do odłączenia GitHub lub usunięcia Konta |
| Zdarzenia bezpieczeństwa: rodzaj zdarzenia, nazwa Konta, adres IP (dla IPv6 – prefiks /64), czas | bezpieczeństwo Serwisu, wykrywanie nadużyć i ataków | art. 6 ust. 1 lit. f (prawnie uzasadniony interes: bezpieczeństwo sieci i informacji, motyw 49 RODO) | 30 dni |
| Liczniki limitów i blokad (adres IP, liczba żądań) | ochrona przed przeciążeniem i nadużyciami | art. 6 ust. 1 lit. f | w pamięci serwera, od minut do godzin |
| Dzienniki techniczne: własne pliki dzienników serwera (wyjście serwera, operacje na usługach dodatkowych, aktualizacje; sekrety są usuwane przed zapisem) oraz dzienniki serwera pocztowego i serwera pośredniczącego (adres IP, czas, adres strony, przeglądarka, status; przy poczcie – adres odbiorcy i status doręczenia) | działanie i bezpieczeństwo Serwisu, usuwanie awarii | art. 6 ust. 1 lit. f | do {{logRetentionDays}} dni |
| Wiadomości e-mail wysyłane do Ciebie (adres odbiorcy i wygenerowana treść transakcyjna, np. nazwa Konta lub jednorazowy link) | potwierdzenie adresu, reset hasła, powiadomienia o bezpieczeństwie i zmianach | art. 6 ust. 1 lit. b i f | wiadomości są przekazywane wyłącznie w celu doręczenia; dzienniki doręczeń jak wyżej; adres, na który poczta nie dochodzi, jest blokowany na 30 dni (zapisywany wyłącznie jako skrót) |
| Korespondencja z Operatorem, reklamacje, zgłoszenia nielegalnych treści | obsługa spraw, obowiązki z DSA, obrona przed roszczeniami | art. 6 ust. 1 lit. c (DSA) i f | do zakończenia sprawy, a potem do przedawnienia roszczeń |
| Adresy stron podane do pobrania (oferty pracy, strony firm) lub audytu | wykonanie żądanej funkcji | art. 6 ust. 1 lit. b | razem z ofertą lub historią audytów |

Operator nie korzysta z Twoich danych do marketingu, profilowania ani trenowania modeli AI i nikomu ich nie sprzedaje. Z narzędzi działających w przeglądarce dane trafiają na serwer tylko wtedy, gdy narzędzie musi wykonać obliczenia na serwerze (np. OCR); pliki robocze są usuwane po zakończeniu zadania.

## 4. Odbiorcy danych {#odbiorcy}

- **{{mailRelay}}** – dostawca serwera wirtualnego używanego wyłącznie jako przekaźnik poczty wychodzącej. W celu doręczenia otrzymuje adres odbiorcy, wygenerowaną treść wiadomości transakcyjnej (która może zawierać nazwę Konta lub jednorazowy link) oraz metadane techniczne doręczenia. Nie otrzymuje pozostałych danych Konta, takich jak CV, dokumenty ani rozmowy z Asystentem. Działa w tym zakresie jako podmiot przetwarzający (art. 28 RODO).
- **Dostawca AI, którego wybrałeś** – gdy korzystasz z Asystenta AI, Serwis przesyła na Twoje polecenie treść rozmowy i dane z otwartych narzędzi do adresu skonfigurowanego na Twoim Koncie; gdy przepływ uruchamia węzeł AI, dane przekazane temu węzłowi trafiają do Dostawcy z profilu lub danych uwierzytelniających wskazanych w węźle. Dostawca przetwarza je na podstawie **Twojej umowy z nim** i własnej polityki prywatności, a nie na zlecenie Operatora. Nie wysyłaj tam danych innych osób, do których udostępnienia nie masz prawa.
- **Adresy i usługi, z którymi łączą się Twoje przepływy** – węzeł żądania HTTP lub integracji wysyła to, co przekaże mu przepływ, na adres wpisany w węźle, z zapisanymi przez Ciebie danymi uwierzytelniającymi; gdy łączysz aplikację OAuth, w logowaniu uczestniczy jej dostawca (np. Google, Microsoft lub GitHub). Ci odbiorcy działają w ramach Twojej relacji z nimi, a nie na zlecenie Operatora. Kto wywoła Twój adres webhook, otrzymuje odpowiedź, którą zwraca Twój przepływ.
- **GitHub, Inc.** (USA) – przy logowaniu przez GitHub i pracy z repozytorium; GitHub działa jako niezależny administrator danych w Twoim koncie GitHub ([polityka prywatności GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)). Do GitHub trafiają też zapytania o aktualizacje aplikacji Craft (pkt 2), bez danych o Tobie.
- **Google LLC** (USA) – przy audycie strony usługą PageSpeed Insights trafia tam adres audytowanej strony (z serwera Operatora, bez Twojego adresu IP).
- **Strony, które wskazujesz** (oferty pracy, strony firm, audytowane witryny, adresy wywoływane przez Twoje przepływy) – widzą adres IP serwera Operatora, a nie Twój.
- Organy publiczne – wyłącznie gdy wymaga tego prawo.

## 5. Przekazywanie danych poza Europejski Obszar Gospodarczy {#transfer}

GitHub i Google mają siedzibę w USA. Przekazywanie opiera się na decyzji Komisji Europejskiej (UE) 2023/1795 w sprawie ram ochrony danych UE–USA (Data Privacy Framework), jeżeli odbiorca jest nimi objęty, a w pozostałych przypadkach na standardowych klauzulach umownych. Jeżeli wybrany przez Ciebie Dostawca AI albo usługa, z którą łączy się Twój przepływ, ma siedzibę poza EOG, przesyłanie do niej jest niezbędne do wykonania usługi, o którą prosisz (art. 49 ust. 1 lit. b RODO), a dalsze przetwarzanie reguluje Twoja umowa z tym dostawcą.

## 6. Pliki cookie i pamięć przeglądarki {#cookies}

Serwis zapisuje na Twoim urządzeniu wyłącznie informacje **niezbędne do świadczenia usługi, o którą prosisz** (art. 399 ust. 3 ustawy – Prawo komunikacji elektronicznej), dlatego nie prosi o zgodę. Nie ma analityki, reklam ani skryptów zewnętrznych.

| Nazwa | Rodzaj | Cel | Czas |
|---|---|---|---|
| `knife_session` | cookie | zalogowanie | do 30 dni |
| `knife_device` | cookie | rozpoznanie urządzenia, na którym już się logowałeś (ochrona przed przejęciem Konta) | do 180 dni |
| `knife_gh_state` | cookie | zabezpieczenie logowania przez GitHub | 10 minut |
| `knife_office` | cookie pod adresem edytora dokumentów (jeżeli jest udostępniany) | wczytanie edytora dla Twojego dokumentu | do 6 godzin |
| `knife_craft` | cookie pod adresem aplikacji Craft (jeżeli są udostępniane) | wczytanie aplikacji Craft | do 12 godzin |
| własna pamięć aplikacji Craft (ustawienia, biblioteki zdjęć, projekty i multimedia, kopie odzyskiwania otwartych dokumentów) | pamięć lokalna, IndexedDB, OPFS pod adresem aplikacji Craft | działanie aplikacji w Twojej przeglądarce | do usunięcia w przeglądarce; nigdy nie trafia na serwer |
| `knife:account` | pamięć lokalna pod adresem aplikacji Craft | nieczytelny znacznik Konta, które ostatnio korzystało z aplikacji w tej przeglądarce, aby przed ich otwarciem usunąć lokalne dane innego Konta | do usunięcia w przeglądarce |
| `sk-theme`, ustawienia narzędzi | pamięć lokalna | jasny lub ciemny motyw, Twoje ustawienia narzędzi | do usunięcia w przeglądarce |
| kopia rozmowy z Asystentem, kolejka wiadomości, tryb zaufania, ustawienia SQL | pamięć lokalna | działanie Asystenta i narzędzi bez ponownego pobierania | usuwane przy wylogowaniu |

Możesz usunąć te dane w ustawieniach przeglądarki; bez cookie sesji nie da się zalogować.

## 7. Twoje prawa {#prawa}

Masz prawo do: dostępu do danych i otrzymania ich kopii, sprostowania, usunięcia, ograniczenia przetwarzania, przenoszenia danych oraz **sprzeciwu** wobec przetwarzania opartego na prawnie uzasadnionym interesie (art. 15–21 RODO). Konto i wszystkie jego dane usuniesz sam w ustawieniach Konta, a ich części tam, gdzie są wyświetlane: dokumenty i pliki Craft („My files”), przepływy pracy, ich uruchomienia i dane uwierzytelniające (w edytorze przepływów). Pozostałe żądania wyślij na adres {{contactEmail}}. Operator odpowiada bez zbędnej zwłoki, najpóźniej w ciągu miesiąca. Jeżeli wysłałeś dane na adres webhook przepływu innego Użytkownika, możesz zwrócić się także do niego; Operator pomaga, gdy Użytkownik nie odpowiada.

## 8. Skarga do organu nadzorczego {#skarga}

Masz prawo wnieść skargę do **Prezesa Urzędu Ochrony Danych Osobowych**, ul. Stanisława Moniuszki 1A, 00-014 Warszawa ([uodo.gov.pl](https://uodo.gov.pl)).

## 9. Czy musisz podać dane {#wymog}

Podanie nazwy użytkownika, adresu e-mail i hasła (albo zalogowanie przez GitHub) jest warunkiem założenia Konta. Pozostałe dane podajesz dobrowolnie, korzystając z wybranych funkcji; klucz API Dostawcy AI jest potrzebny tylko do Asystenta AI i węzłów AI.

## 10. Bezpieczeństwo i naruszenia {#bezpieczenstwo}

Połączenia są szyfrowane (HTTPS), pliki Kont, klucze API i dane uwierzytelniające przepływów są zaszyfrowane, hasła są przechowywane jako skróty, serwer jest chroniony zaporą i limitami, a narzędzia przetwarzające pliki działają w odizolowanym środowisku (sandbox). Przepływy pracy działają w osobnym procesie bez dostępu do plików serwera i do innych Kont; kod, który piszesz w przepływie, działa w dodatkowej piaskownicy z limitami czasu i pamięci, a w publicznym Serwisie przepływy nie mogą łączyć się z adresami w prywatnej sieci Operatora. Aplikacje Craft działają pod własnym adresem, oddzielonym od Serwisu, więc nie mają dostępu do Twojego Konta. Jeżeli dojdzie do naruszenia ochrony danych, Operator zgłosi je Prezesowi UODO w ciągu 72 godzin, gdy jest to wymagane, a w razie wysokiego ryzyka niezwłocznie poinformuje Ciebie.

## 11. Zautomatyzowane decyzje {#decyzje}

Operator nie podejmuje decyzji opartych wyłącznie na zautomatyzowanym przetwarzaniu, w tym profilowaniu, które wywołują wobec Ciebie skutki prawne lub w podobny sposób istotnie na Ciebie wpływają. Automatyczne limity i blokady chroniące przed nadużyciami są tymczasowe i nie oceniają Twojej osoby. Przepływy pracy robią to, co zbudował ich Użytkownik; Operator nie używa ich do podejmowania decyzji o Tobie.

## 12. Wiek {#wiek}

Serwis jest przeznaczony dla osób, które ukończyły {{minimumAge}} lat.

## 13. Dane szczególne i dane innych osób {#szczegolne}

CV może zawierać dane szczególnych kategorii (np. o zdrowiu lub niepełnosprawności) i dane innych osób (np. referencje), a przepływ pracy może przetwarzać dane innych osób (np. wiadomości lub wpisy z formularzy, które otrzymuje lub pobiera). Zapisuj i przetwarzaj je tylko wtedy, gdy to potrzebne i masz do tego prawo.

## 14. Zmiany {#zmiany}

O istotnych zmianach tej Polityki Operator informuje e-mailem i w Serwisie, tak jak o zmianach Regulaminu.

## 15. Wersje tej Polityki i serwisu {{siteName}} {#versions}

Każda zmiana tekstu lub danych instancji tworzy nową wersję. Na dole tej strony widać jej wydanie, odcisk (krótki kod obliczony z pełnego tekstu) oraz wersję serwisu {{siteName}}, na której działa serwer; tam też są wymienione wcześniejsze wersje, które można nadal przeczytać. W ustawieniach Konta widać wersję zaakceptowaną przy rejestracji.

Co dodały kolejne wersje serwisu {{siteName}}, istotne dla Twoich danych:

| Wersja {{siteName}} | Co dodała | Co to oznacza dla Twoich danych |
|---|---|---|
| 0.1 | Konta, narzędzia w przeglądarce, studio CV, dokumenty biurowe, kurs baz danych, studio stron, Asystent AI, klucze MCP, logowanie przez GitHub | jak w wydaniu 1 tej Polityki |
| 0.2 | Własne pliki dzienników serwera; aplikacje Craft | dzienniki techniczne do {{logRetentionDays}} dni; aplikacje przechowują Twoją pracę w przeglądarce |
| 0.4 | Automatyczne aktualizacje aplikacji Craft z GitHub | zapytania do GitHub bez danych o Tobie |
| 0.5 | Pliki Craft: zapisywanie pracy z aplikacji Craft na Koncie | przechowywane zaszyfrowane na Koncie, wliczane do limitu miejsca |
| 0.6.1 | Kilka nazwanych profili Dostawcy AI | klucz API każdego profilu przechowywany zaszyfrowany |
| 0.7.0 | Przepływy pracy: automatyzacje z harmonogramami, adresami webhook, kodem i danymi uwierzytelniającymi | przepływy, historia uruchomień (100 uruchomień, 14 dni), zaszyfrowane dane uwierzytelniające, dane wysyłane na Twoje webhooki |
| 0.7.1 | Węzły AI w przepływach; Asystent i MCP mogą budować i uruchamiać przepływy | dane przepływu trafiają do wybranego przez Ciebie Dostawcy AI; zużycie tokenów jest liczone |
| 0.8.0 | Wersje Regulaminu i tej Polityki: wcześniejsze wersje pozostają dostępne | wersja zaakceptowana przez Ciebie jest widoczna na Koncie; bez nowych danych osobowych |

Zmiany:

- **Wydanie 2** (22 października 2026, {{siteName}} 0.8.0): opisuje aplikacje Craft i pliki Craft, przepływy pracy (historia uruchomień, dane uwierzytelniające, webhooki, węzły AI), kilka profili Dostawcy AI, własne pliki dzienników serwera oraz pozycje `knife_office`, `knife_craft` i pamięć aplikacji Craft; dodaje ten punkt.
- **Wydanie 1** (21 października 2026, {{siteName}} 0.1): pierwsza wersja.
