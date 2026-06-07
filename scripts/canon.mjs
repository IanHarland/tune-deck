// canon.mjs — the jazz repertoire that actually gets called, tiered for
// obscurity. Compiled from jam-session frequency data + must-know consensus
// lists (standardrepertoire.com jam-call data, learnjazzstandards, the
// "tunes called repeatedly at jams" lists) and domain knowledge. See the chat
// that produced this for sources.
//
// The point: ~300 tunes make up almost everything ever called. Canon membership
// is the ONLY thing that keeps a tune's obscurity low; everything not here
// trends toward 100 (probably never called at a jam). Tiers, low→high obscurity:
//   CORE     — everyone calls these everywhere
//   STANDARD — solid must-knows
//   COMMON   — known, called sometimes
//
// Matching is by normalized title (lowercase, alphanumerics only), so
// punctuation/spelling variants ("St. Thomas" / "St Thomas") collapse together.

export const CORE = [
  "Autumn Leaves", "All The Things You Are", "All Of Me", "All Blues",
  "Blue Bossa", "Blue Monk", "Black Orpheus", "Billie's Bounce", "Body and Soul",
  "Bye Bye Blackbird", "Cherokee", "Confirmation", "Four", "Footprints",
  "On Green Dolphin Street", "Green Dolphin Street", "Have You Met Miss Jones",
  "How High The Moon", "In A Mellow Tone", "It Could Happen To You",
  "Just Friends", "Maiden Voyage", "Misty", "Mr. P.C.", "A Night In Tunisia",
  "Night In Tunisia", "Now's The Time", "Oleo", "Ornithology", "Out Of Nowhere",
  "Recorda Me", "Recordame", "No Me Esqueca", "Satin Doll",
  "Scrapple From The Apple", "Softly As In A Morning Sunrise", "So What", "Solar",
  "St. Thomas", "Stella By Starlight", "Straight No Chaser", "Summertime",
  "Sweet Georgia Brown", "Take The A Train", "Tenor Madness",
  "There Will Never Be Another You", "Tune Up", "Up Jumped Spring", "Wave",
  "Well You Needn't", "Yardbird Suite", "Doxy", "Caravan", "Fly Me To The Moon",
  "Beautiful Love", "Anthropology", "Lady Bird", "Ladybird", "Sonnymoon For Two",
  "My Funny Valentine", "Days Of Wine And Roses", "Stompin' At The Savoy",
  "Take Five",
];

export const STANDARD = [
  "A Child Is Born", "Afternoon In Paris", "Airegin", "Alone Together",
  "Beatrice", "Blue In Green", "Blues For Alice", "C Jam Blues",
  "Cantaloupe Island", "Ceora", "Corcovado", "Cotton Tail", "Countdown",
  "Desafinado", "Dolphin Dance", "Donna Lee", "Embraceable You", "Equinox",
  "Giant Steps", "The Girl From Ipanema", "Girl From Ipanema", "Good Bait",
  "I Got Rhythm", "I Remember Clifford", "I'll Remember April", "Impressions",
  "In A Sentimental Mood", "Invitation", "Jordu", "Joy Spring", "Killer Joe",
  "Lazy Bird", "Lester Leaps In", "Love For Sale", "Lullaby Of Birdland",
  "Manteca", "Mercy Mercy Mercy", "Milestones", "Moanin'", "Moment's Notice",
  "Moonlight In Vermont", "My Romance", "Naima", "Nardis", "Night And Day",
  "Nica's Dream", "One Note Samba", "Perdido", "Prelude To A Kiss",
  "Rhythm-A-Ning", "'Round Midnight", "Round Midnight", "Sidewinder",
  "Sister Sadie", "Song For My Father", "Sophisticated Lady", "Speak No Evil",
  "Spain", "Star Eyes", "Stolen Moments", "Sugar", "Tea For Two",
  "The Way You Look Tonight", "These Foolish Things", "This I Dig Of You",
  "Watermelon Man", "Whisper Not", "Willow Weep For Me", "Witch Hunt",
  "Work Song", "Yesterdays", "Cool Blues", "Cousin Mary", "Some Other Blues",
  "Birk's Works", "Freedom Jazz Dance", "Jeannine", "Dat Dere", "Dig",
  "Jitterbug Waltz", "Pent Up House", "Stablemates", "If I Were A Bell",
  "There Is No Greater Love", "What Is This Thing Called Love",
  "Like Someone In Love", "I Love You", "Bye Bye Blackbird", "Inner Urge",
  "Blue Train", "Triste", "How Insensitive", "Bésame Mucho", "Besame Mucho",
  "Alice In Wonderland", "Stablemates",
];

export const COMMON = [
  "Ain't Misbehavin'", "Autumn In New York", "Basin Street Blues", "Blue Moon",
  "Chelsea Bridge", "Do Nothin' Till You Hear From Me", "Flamingo",
  "A Foggy Day", "Georgia On My Mind", "Here's That Rainy Day",
  "Honeysuckle Rose", "I Can't Get Started", "I Cover The Waterfront",
  "I Didn't Know What Time It Was", "I Got It Bad", "I'm Beginning To See The Light",
  "I'm Getting Sentimental Over You", "Jumpin' With Symphony Sid", "La Fiesta",
  "Oh Lady Be Good", "Lady Be Good", "Laura", "Little Sunflower", "Lonely Woman",
  "Lush Life", "Mack The Knife", "Mean To Me", "Meditation", "Monk's Mood",
  "My Favorite Things", "My Little Suede Shoes", "My One And Only Love",
  "Nefertiti", "Night Train", "On The Sunny Side Of The Street", "Passion Dance",
  "Pennies From Heaven", "Quiet Nights Of Quiet Stars", "Red Top",
  "Robbins Nest", "The Shadow Of Your Smile", "Shiny Stockings", "Skylark",
  "Someone To Watch Over Me", "Stardust", "Tangerine", "Tenderly", "The Preacher",
  "Things Ain't What They Used To Be", "500 Miles High", "Waltz For Debby",
  "Spring Is Here", "On A Slow Boat To China", "Over The Rainbow",
  "When The Saints Go Marching In", "When Sunny Gets Blue", "Lover Come Back To Me",
  "Lover Man", "The Lady Is A Tramp", "In Your Own Sweet Way", "So Danco Samba",
  "Chega De Saudade", "If I Should Lose You", "You Don't Know What Love Is",
  "What's New", "Everything Happens To Me", "I Should Care",
  "Polka Dots And Moonbeams", "Darn That Dream", "I Fall In Love Too Easily",
  "Easy Living", "You Go To My Head", "My Foolish Heart", "Stardust",
  "Gee Baby Ain't I Good To You", "Will You Still Be Mine", "Star Eyes",
  "I Hear A Rhapsody", "Yesterdays", "But Not For Me", "I'm Old Fashioned",
  "It's You Or No One", "You Stepped Out Of A Dream", "Have You Met Miss Jones",
  "Just One Of Those Things", "All Of You", "I Love You", "Softly",
  "There Will Never Be Another You", "Old Devil Moon", "On The Street Where You Live",
  "The Song Is You", "Wives And Lovers", "Whisper Not", "Stablemates",
  "Joy Spring", "Daahoud", "Sandu", "Bags' Groove", "Bag's Groove", "Tenor Madness",
  "Au Privave", "Chi Chi", "Relaxin' At Camarillo", "Moose The Mooche",
  "Half Nelson", "Israel", "Boplicity", "Move", "Budo", "Four On Six",
  "West Coast Blues", "No Blues", "Freddie Freeloader", "Blue Seven",
  "Footprints", "Maiden Voyage", "Cantaloupe Island", "The Sidewinder",
  "Song For My Father", "Ceora", "Recado Bossa Nova", "One For Daddy-O",
  "Doodlin'", "Filthy McNasty", "Watermelon Man", "Comin' Home Baby",
  "Mercy Mercy Mercy", "Cantaloupe Island",
];

// --- difficulty hints (obscurity-independent) ---------------------------- //
export const VERY_EASY = [ // ~10
  "Autumn Leaves", "All Of Me", "C Jam Blues", "Blue Monk", "Bag's Groove",
  "Bags' Groove", "Summertime", "St. Thomas", "Satin Doll", "Take The A Train",
  "Fly Me To The Moon", "Doxy", "Mr. P.C.", "Now's The Time", "Billie's Bounce",
  "Sonnymoon For Two", "Watermelon Man", "Song For My Father", "Tune Up",
  "So What", "Impressions", "All Blues", "Cantaloupe Island", "Blue Bossa",
];

export const EASY = [ // ~26
  "There Is No Greater Love", "Work Song", "Lester Leaps In", "Mack The Knife",
  "Sandu", "Sidewinder", "The Sidewinder", "Maiden Voyage", "Cousin Mary",
  "Some Other Blues", "Tenor Madness", "Equinox", "Oleo", "Killer Joe",
  "My Little Suede Shoes", "Cool Blues", "Au Privave", "Perdido",
  "In A Mellow Tone", "Things Ain't What They Used To Be", "Footprints",
];

export const ADVANCED = [ // ~85
  "Along Came Betty", "Ask Me Now", "Con Alma", "Dolphin Dance", "Donna Lee",
  "Fee-Fi-Fo-Fum", "How Insensitive", "In Your Own Sweet Way", "Invitation",
  "Lazy Bird", "Speak No Evil", "Sweet And Lovely", "Nardis", "Joy Spring",
  "Witch Hunt", "Stablemates", "Ceora", "Isotope", "Iris", "Nefertiti",
  "Black Nile", "Cherokee", "Confirmation", "Anthropology", "Airegin",
  "Stella By Starlight", "Body and Soul", "All The Things You Are",
  "Like Someone In Love", "Yesterdays",
];

export const VERY_HARD = [ // ~93
  "Giant Steps", "Countdown", "Moment's Notice", "26-2", "Inner Urge",
  "Central Park West", "Gnid", "Segment", "Tricotism", "Dance Of The Infidels",
  "Trane Changes", "Have You Met Miss Jones", "Passion Dance", "Punjab",
];
