# Regulamin serwisu {{siteName}}

Obowiązuje od: {{effectiveDate}}. Dla Kont założonych wcześniej zmiany wchodzą w życie zgodnie z § 15. Wiążąca jest wersja polska; wersja angielska ma charakter informacyjny.

## § 1. Operator i kontakt {#operator}

1. Serwis {{siteName}} dostępny pod adresem {{siteUrl}} („**Serwis**”) prowadzi {{operatorName}}, {{postalAddress}} („**Operator**”). Operator jest osobą fizyczną, nie prowadzi działalności gospodarczej i udostępnia Serwis prywatnie, nieodpłatnie i w celach niekomercyjnych.
2. Kontakt z Operatorem: **{{contactEmail}}**. Ten adres jest jednocześnie punktem kontaktowym dla użytkowników oraz dla organów państw członkowskich, Komisji Europejskiej i Europejskiej Rady ds. Usług Cyfrowych w rozumieniu art. 11 i 12 rozporządzenia (UE) 2022/2065 (akt o usługach cyfrowych, „**DSA**”). Korespondencję przyjmujemy w języku polskim i angielskim.
3. Regulamin jest udostępniony bezpłatnie, przed założeniem konta, pod adresem {{siteUrl}}/terms, w formie umożliwiającej jego pobranie, utrwalenie i wydrukowanie (odnośnik „Pobierz”). Zasady przetwarzania danych osobowych opisuje [Polityka prywatności](/privacy).

## § 2. Definicje {#definicje}

- **Użytkownik** – osoba, która założyła Konto.
- **Konto** – indywidualne konto Użytkownika w Serwisie, chronione hasłem lub logowaniem przez GitHub.
- **Treści** – wszystko, co Użytkownik zapisuje lub przesyła w Serwisie: dane profilu i CV, oferty pracy, dokumenty, pliki zapisane z aplikacji Craft, rozmowy z Asystentem AI, przepływy pracy wraz z historią uruchomień i danymi uwierzytelniającymi, ustawienia, kod i pliki repozytoriów.
- **Asystent AI** – wbudowany asystent czatu, który korzysta z modelu językowego wskazanego przez Użytkownika (§ 8).
- **Dostawca AI** – zewnętrzny dostawca modelu językowego, z którym Użytkownik połączył swoje Konto (np. własnym kluczem API).
- **Przepływ pracy** – automatyzacja zbudowana przez Użytkownika z węzłów (np. żądanie HTTP, kod, węzeł AI), uruchamiana ręcznie, według harmonogramu albo przez wywołanie jej adresu webhook.
- **Aplikacje Craft** – programy open source zespołu ArtCraft (m.in. PhotoCraft, VectorCraft, FilmCraft), które Operator udostępnia w Serwisie bez zmian.

## § 3. Charakter Serwisu {#charakter}

1. Serwis jest **bezpłatny**. Nie zawiera reklam, nie śledzi Użytkowników i nie sprzedaje ich danych.
2. Serwis działa na **prywatnym komputerze Operatora w Polsce** i jest projektem hobbystycznym. Operator nie gwarantuje ciągłości ani dostępności Serwisu: możliwe są przerwy techniczne, awarie sprzętu, zasilania lub łącza, a także zakończenie działania Serwisu (§ 13).
3. Narzędzia Serwisu i Asystent AI mogą zwracać wyniki błędne lub niepełne. Użytkownik sam ocenia przydatność wyników i odpowiada za sposób ich wykorzystania. Serwis nie świadczy porad prawnych, podatkowych, medycznych, finansowych ani zawodowych.

## § 4. Zakres usług {#uslugi}

W ramach Serwisu Operator udostępnia, w zakresie włączonym w tej instancji:

1. narzędzia działające w przeglądarce (m.in. tekst, JSON, obrazy, PDF, SQL, kodowanie); część z nich wykonuje obliczenia na serwerze Operatora (np. OCR i przetwarzanie PDF, formatowanie SQL), a pliki robocze są usuwane po zakończeniu zadania;
2. przechowywanie Treści na Koncie, w ramach limitu miejsca ustalanego przez Operatora (domyślnie 1 GiB), w szczególności: studio CV (profil, wersje CV, oferty pracy, śledzenie aplikacji), bibliotekę dokumentów biurowych z edytorem, kurs baz danych z bazą ćwiczeniową, studio stron internetowych współpracujące z repozytorium GitHub Użytkownika (w tym audyty stron);
3. Asystenta AI (§ 8);
4. przepływy pracy: tworzenie, uruchamianie i historię uruchomień automatyzacji, wykonywanych na serwerze Operatora w odizolowanym środowisku i w granicach limitów (czas, liczba uruchomień, rozmiar danych), z danymi uwierzytelniającymi do usług wskazanych przez Użytkownika i adresami webhook, które Użytkownik może przekazywać innym osobom;
5. aplikacje Craft działające w przeglądarce, z możliwością zapisywania plików na Koncie. Operator nie jest ich autorem i udostępnia je takimi, jakie wydali ich autorzy; do samych programów stosuje się ich licencje (MIT lub Apache-2.0), wskazane w każdej aplikacji wraz z informacją o autorach. Zespół ArtCraft nie jest stroną umowy ani nie popiera Serwisu;
6. dostęp do Konta dla programów i agentów Użytkownika przez klucze MCP tworzone przez Użytkownika;
7. logowanie przez GitHub („Sign in with GitHub”), jeżeli Operator je włączył.

## § 5. Wymagania techniczne {#wymagania}

Do korzystania z Serwisu potrzebne są: urządzenie z dostępem do internetu, aktualna przeglądarka z włączonym JavaScriptem i obsługą niezbędnych plików cookie (opis w Polityce prywatności) oraz adres e-mail. Niektóre funkcje wymagają konta w serwisie GitHub albo konta u Dostawcy AI i klucza API.

## § 6. Konto i zawarcie umowy {#konto}

1. Umowa o świadczenie usług drogą elektroniczną zostaje zawarta z chwilą założenia Konta: po zaakceptowaniu Regulaminu i zapoznaniu się z Polityką prywatności, przez potwierdzenie adresu e-mail albo przez logowanie przez GitHub. Bez Konta dostępne są wyłącznie strony publiczne.
2. Konto może założyć osoba, która ukończyła **{{minimumAge}} lat**. Osoba niepełnoletnia oświadcza, że ma zgodę swojego przedstawiciela ustawowego.
3. Jedna osoba – jedno Konto. Konta nie wolno udostępniać innym osobom. Użytkownik podaje prawdziwy adres e-mail, chroni hasło i klucze MCP oraz odpowiada za działania wykonane z ich użyciem. O podejrzeniu przejęcia Konta należy niezwłocznie powiadomić Operatora.
4. Konto niepotwierdzone w ciągu 24 godzin od rejestracji jest usuwane automatycznie.

## § 7. Zasady korzystania {#zasady}

Zabronione jest w szczególności:

1. dostarczanie lub przechowywanie treści o charakterze bezprawnym, w tym naruszających prawa autorskie, dobra osobiste lub prywatność innych osób;
2. przesyłanie złośliwego oprogramowania, próby ataku na Serwis lub jego użytkowników, skanowanie, testy obciążeniowe, obchodzenie limitów, zabezpieczeń lub piaskownicy (sandboxa) narzędzi;
3. automatyczne zakładanie kont i masowe zautomatyzowane korzystanie z Serwisu (poza korzystaniem z własnego Konta przez klucze MCP w ramach limitów);
4. używanie funkcji pobierania ofert pracy i audytu stron do stron, do których Użytkownik nie ma prawa, albo do masowego pobierania (scrapingu) cudzych treści;
5. zapisywanie danych osobowych innych osób bez podstawy prawnej oraz – bez potrzeby – szczególnych kategorii danych (np. o zdrowiu);
6. wykorzystywanie wyników Serwisu lub Asystenta AI do podejmowania decyzji o innych osobach (np. selekcji kandydatów do pracy);
7. wysyłanie spamu i odsprzedawanie dostępu do Serwisu;
8. naruszanie warunków korzystania z usług Dostawcy AI i serwisu GitHub przy korzystaniu z nich przez Serwis;
9. używanie przepływów pracy do wysyłania spamu, ataków na cudze usługi, obchodzenia ich zabezpieczeń lub limitów, masowego pobierania cudzych treści albo do udostępniania pod adresem Serwisu treści podszywających się pod inne serwisy (phishing);
10. zapisywanie w danych uwierzytelniających haseł, kluczy lub tokenów, do których używania Użytkownik nie ma prawa.

## § 8. Asystent AI {#ai}

1. **Asystent AI jest systemem sztucznej inteligencji.** Rozmawiając z nim, Użytkownik komunikuje się z programem, a nie z człowiekiem (art. 50 rozporządzenia (UE) 2024/1689, „akt w sprawie sztucznej inteligencji”).
2. Asystent korzysta z modelu językowego **Dostawcy AI wybranego i skonfigurowanego przez Użytkownika** w ustawieniach Konta. Treść rozmowy oraz dane, które Asystent odczytuje z otwartych narzędzi i stron na prośbę Użytkownika, są przesyłane do tego Dostawcy AI. Do tego przesyłania i przetwarzania stosuje się warunki i polityka prywatności Dostawcy AI, który może mieć siedzibę poza Europejskim Obszarem Gospodarczym. Ewentualne opłaty u Dostawcy AI ponosi Użytkownik.
3. Odpowiedzi Asystenta mogą być błędne, niepełne lub nieaktualne. Asystent może na polecenie Użytkownika wykonywać działania w jego narzędziach, w granicach wybranego trybu zaufania; działania nieodwracalne wymagają potwierdzenia. Użytkownik sprawdza wyniki przed ich użyciem.
4. Użytkownik, który publikuje teksty wygenerowane przez AI w sprawach interesu publicznego, może być zobowiązany ujawnić, że zostały wygenerowane sztucznie (art. 50 ust. 4 aktu w sprawie sztucznej inteligencji).
5. Węzły AI w przepływach pracy (np. AI Agent) przesyłają dane przepływu do Dostawcy AI wskazanego w profilu lub danych uwierzytelniających węzła; ust. 2 i 3 stosuje się odpowiednio. Przepływ działa bez bieżącego udziału Użytkownika: Użytkownik odpowiada za to, co przepływ i model wykonują w jego imieniu.
6. Jeżeli przepływ Użytkownika pozwala innym osobom komunikować się z modelem AI (np. odpowiada na wiadomości przez webhook), Użytkownik informuje te osoby, że komunikują się z systemem sztucznej inteligencji (art. 50 ust. 1 aktu w sprawie sztucznej inteligencji).

## § 9. Treści Użytkownika {#tresci}

1. Użytkownik zachowuje wszelkie prawa do swoich Treści.
2. Użytkownik udziela Operatorowi nieodpłatnej, niewyłącznej licencji, bez ograniczeń terytorialnych, na czas przechowywania Treści w Serwisie, **wyłącznie w celu świadczenia usług**, na polach eksploatacji: utrwalanie i zwielokrotnianie (zapis na nośnikach Operatora, kopie zapasowe), zmiana formatu (np. konwersja dokumentów, PDF, OCR), wyświetlanie Użytkownikowi oraz przesyłanie do usług wskazanych przez Użytkownika (Dostawca AI, GitHub, poczta e-mail, adresy i usługi, z którymi łączą się przepływy pracy Użytkownika). Licencja wygasa z chwilą usunięcia Treści, z zastrzeżeniem kopii zapasowych opisanych w Polityce prywatności.
3. Użytkownik oświadcza, że ma prawo do przetwarzania swoich Treści w Serwisie.
4. Operator nie przegląda Treści i nie ma ogólnego obowiązku ich monitorowania (art. 8 DSA). Treści są przechowywane w postaci zaszyfrowanej.

## § 10. Zgłaszanie nielegalnych treści i moderacja {#zgloszenia}

1. Każdy może zgłosić treść, którą uważa za nielegalną, na adres {{contactEmail}}. Zgłoszenie powinno zawierać: uzasadnienie, dlaczego treść jest nielegalna; dokładne wskazanie treści (adres lub identyfikator); imię i nazwisko oraz adres e-mail zgłaszającego (nie dotyczy zgłoszeń niektórych przestępstw) oraz oświadczenie o działaniu w dobrej wierze (art. 16 DSA).
2. Operator potwierdza otrzymanie zgłoszenia, rozpatruje je starannie i obiektywnie, bez użycia zautomatyzowanych narzędzi, i informuje zgłaszającego o decyzji.
3. Operator może usunąć lub zablokować treść, zawiesić albo usunąć Konto, jeżeli treść jest nielegalna lub narusza Regulamin. Użytkownik otrzymuje e-mailem uzasadnienie zawierające opis decyzji, fakty, podstawę i możliwości odwołania (art. 17 DSA).
4. Od decyzji można się odwołać, odpowiadając na wiadomość w ciągu 6 miesięcy. Operator ponownie rozpatruje sprawę. Użytkownikowi przysługuje też droga sądowa.
5. Operator powiadamia organy ścigania o informacjach wskazujących na przestępstwo zagrażające życiu lub bezpieczeństwu osób (art. 18 DSA).
6. Operator nie stosuje zautomatyzowanej moderacji treści. Limity liczby zapytań, zabezpieczenia przed nadużyciami i obliczeniowe wyzwania (proof-of-work) są automatycznymi środkami bezpieczeństwa technicznego, a nie oceną treści.

## § 11. Dostępność i kopie danych {#kopie}

1. Operator nie zapewnia gwarantowanej dostępności (SLA) ani kopii zapasowych na rzecz Użytkownika. **Użytkownik powinien przechowywać własne kopie ważnych Treści.**
2. Dokumenty, wersje CV i inne Treści można pobierać w Serwisie. Na żądanie wysłane na adres {{contactEmail}} Operator przekazuje kopię danych Konta w formacie nadającym się do odczytu maszynowego.

## § 12. Odpowiedzialność {#odpowiedzialnosc}

1. W granicach dopuszczalnych przez prawo Operator odpowiada wyłącznie za szkody wyrządzone umyślnie lub wskutek rażącego niedbalstwa. W szczególności Operator nie odpowiada za: utratę danych wskutek awarii, przerwy w działaniu Serwisu, treść odpowiedzi Asystenta AI i wyników narzędzi, działanie usług zewnętrznych (Dostawca AI, GitHub, Google oraz usługi, z którymi łączą się przepływy pracy), skutki działań przepływów pracy Użytkownika, działanie aplikacji Craft (oprogramowania osób trzecich), skutki wykorzystania wyników przez Użytkownika oraz koszty u Dostawcy AI.
2. Postanowienie ust. 1 nie ogranicza odpowiedzialności w zakresie, w jakim nie pozwalają na to bezwzględnie obowiązujące przepisy, w tym za szkodę wyrządzoną umyślnie.
3. Użytkownik odpowiada za naruszenie Regulaminu i przepisów prawa przy korzystaniu z Serwisu.

## § 13. Rozwiązanie umowy {#rozwiazanie}

1. Użytkownik może w każdej chwili rozwiązać umowę, usuwając Konto w ustawieniach Konta (dane są usuwane od razu, kopie zapasowe zgodnie z Polityką prywatności) albo pisząc na adres {{contactEmail}}.
2. Operator może rozwiązać umowę: (a) ze skutkiem natychmiastowym w razie poważnego lub uporczywego naruszenia Regulaminu, nielegalnych treści albo zagrożenia bezpieczeństwa Serwisu, z uzasadnieniem zgodnie z § 10 ust. 3; (b) w innych przypadkach z zachowaniem {{shutdownNoticeDays}} dni wypowiedzenia przesłanego e-mailem.
3. Operator może zakończyć działanie Serwisu, informując Użytkowników e-mailem co najmniej {{shutdownNoticeDays}} dni wcześniej. W tym czasie Użytkownik może pobrać swoje Treści.

## § 14. Reklamacje {#reklamacje}

1. Reklamacje dotyczące Serwisu należy wysyłać na adres {{contactEmail}}, podając nazwę Konta, opis problemu i oczekiwany sposób rozwiązania.
2. Operator odpowiada e-mailem w ciągu {{complaintDays}} dni od otrzymania reklamacji.

## § 15. Zmiany Regulaminu {#zmiany}

1. Operator może zmienić Regulamin z ważnych przyczyn, w szczególności z powodu zmiany przepisów, zmiany funkcji Serwisu lub względów bezpieczeństwa.
2. O zmianie Operator informuje e-mailem i w Serwisie co najmniej **{{changeNoticeDays}} dni** przed jej wejściem w życie. Użytkownik, który nie akceptuje zmian, może przed tym dniem rozwiązać umowę, usuwając Konto. Dalsze korzystanie z Serwisu po wejściu zmian w życie oznacza ich akceptację.
3. Zmiany wymagane przez prawo albo niezbędne z pilnych względów bezpieczeństwa mogą wejść w życie od razu.
4. Każda wersja Regulaminu i Polityki prywatności ma oznaczenie (wydanie i odcisk – krótki kod obliczony z pełnego tekstu) oraz datę publikacji, widoczne na dole strony. Wcześniejsze wersje pozostają dostępne w Serwisie, a w ustawieniach Konta widać wersję zaakceptowaną przez Użytkownika. Nowa wersja obowiązuje od razu Konta zakładane po jej publikacji, a Konta założone wcześniej – po upływie terminu z ust. 2, o ile ust. 3 nie stanowi inaczej; do tego czasu stosuje się wobec nich poprzednią wersję.

## § 16. Postanowienia końcowe {#koncowe}

1. Do umowy stosuje się prawo polskie. Spory rozstrzyga sąd właściwy według przepisów ogólnych.
2. Regulamin nie wyłącza ani nie ogranicza ochrony, jaką przyznają konsumentowi bezwzględnie obowiązujące przepisy prawa państwa jego zwykłego pobytu, jeżeli przepisy te mają zastosowanie.
3. Nieważność jednego z postanowień nie wpływa na ważność pozostałych.

## § 17. Historia zmian {#history}

- **Wydanie 4** (28 października 2026, {{siteName}} 0.13.0): bez zmian postanowień; studio strony może opcjonalnie współpracować z projektem Vercel Użytkownika, co opisuje Polityka prywatności.
- **Wydanie 3** (26 października 2026, {{siteName}} 0.10.0): bez zmian postanowień; Serwis jest dostępny po polsku i po angielsku, a Polityka prywatności opisuje zapisywany wybór języka.
- **Wydanie 2** (22 października 2026, {{siteName}} 0.8.0): dodaje przepływy pracy i aplikacje Craft (§ 2, § 4 pkt 4–5), zasady korzystania z przepływów (§ 7 pkt 9–10), węzły AI (§ 8 ust. 5–6), rozszerza licencję i wyłączenia odpowiedzialności o przepływy i aplikacje Craft (§ 9 ust. 2, § 12 ust. 1) oraz opisuje wersje dokumentów (§ 15 ust. 4).
- **Wydanie 1** (21 października 2026, {{siteName}} 0.1): pierwsza wersja.
