/**
 * Flash Peak TMS - Authoritative Flash Peak Game Knowledge Base
 *
 * Sourced directly from game asset bundles and decompiled engine assemblies
 * in D:\Projects\FlashPeak (FootballPlayerMainTable, FootballPlayerAbilityTable,
 * FootballPlayerAttributeTable, FootballPlayerPassiveSkillTable, PlayerBeShoulderBargeTransition,
 * GameMapTable, GameModeTable, Rank, Item, and ProjectCR.Runtime.dll).
 *
 * Injected into Omak Peak trusted context so the AI possesses authoritative,
 * exhaustive gameplay knowledge (characters, skills, attributes, physics,
 * combat formulas, passive abilities, and tactical matchup counters).
 */

export interface CharacterKnowledge {
  id: number;
  name: string;
  localized_name: string;
  role: 'ST' | 'CM' | 'CB' | 'WF' | 'GK';
  power: number;
  speed: number;
  stamina: number;
  shoot: number;
  pass: number;
  dribble: number;
  defense: number;
  small_skill: {
    name: string;
    in_game_name_id: string;
    cost_type: 'Stamina' | 'None';
    cost_val: number;
    description: string;
  };
  ultimate_skill: {
    name: string;
    in_game_name_id: string;
    cost_energy: number;
    range_or_duration: string;
    description: string;
  };
  key_passives: string[];
  playstyle_summary: string;
}

export interface FlashPeakGameKnowledge {
  game_overview: {
    format: string;
    match_duration_sec: number;
    pitch_dimensions: string;
    rules: string[];
  };
  maps: Array<{
    id: number;
    name: string;
    scene: string;
    surface: string;
    physics_characteristics: string;
  }>;
  ranked_system: {
    tiers: string[];
    star_system: string;
  };
  combat_and_collision_rules: {
    shoulder_barge_formula: string;
    double_teaming_penalty: string;
    energy_and_stamina_rules: string;
    goalkeeper_rules: string;
    final_play_rule: string;
  };
  characters: CharacterKnowledge[];
  all_passive_skills: Record<string, string>;
  tactical_matchup_playbook: Record<string, string>;
}

export const FLASH_PEAK_GAME_KNOWLEDGE: FlashPeakGameKnowledge = {
  game_overview: {
    format: '4v4 Street / Arcade Football (Outfield 3v3 + 1 AI/Manual GK)',
    match_duration_sec: 300,
    pitch_dimensions: '66.0m (lebar) x 103.0m (panjang) x 20.0m (tinggi)',
    rules: [
      'Tanpa offside — rotasi bebas, overlap, dan cherry-picking sepenuhnya legal.',
      'Durasi pertandingan 5 menit (300 detik) continuous play.',
      'Mercy rule aktif bila selisih skor mencapai 3 gol di babak tertentu.',
      'Skor imbang saat waktu habis memicu Golden Goal (sudden death).',
      'Final Play (Serangan Terakhir): Jika waktu 5 menit habis tapi bola masih dalam fase ancaman serangan, peluit akhir ditahan sampai bola direbut atau keluar lapangan.',
      'Item Room Card (Item ID 22) adalah kartu yang digunakan delegasi/host untuk membuat custom room turnamen.',
    ],
  },
  maps: [
    {
      id: 1,
      name: 'Pantai (Beach Stadium)',
      scene: 'Field_Pantai',
      surface: 'Grass (Rumput Alami)',
      physics_characteristics: 'Pantulan bola standar (Bounciness 0.5), rolling resistance 0.5, gesekan stabil untuk umpan datar.',
    },
    {
      id: 2,
      name: 'Marrakech (Morocco Street)',
      scene: 'Field_Marrakech',
      surface: 'Concrete (Semen/Aspal Keras)',
      physics_characteristics: 'Permukaan keras membuat pantulan bola lebih tinggi dan laju bola lebih kencang dibanding rumput Pantai.',
    },
  ],
  ranked_system: {
    tiers: ['Bronze (1-3)', 'Silver (1-3)', 'Gold (1-4)', 'Platinum (1-4)', 'Diamond', 'Master', 'Heroic'],
    star_system: 'Sistem bintang kemenangan dengan Rank Protect (perlindungan bintang saat kalah di tier awal).',
  },
  combat_and_collision_rules: {
    shoulder_barge_formula:
      'Shoulder Barge (Benturan Bahu) dihitung dari Delta Power = Power Penyerang - Power Bertahan (jarak 2.0m, biaya 400 Stamina). Jika Delta Power > 25 (misal Andrew Power 87 menabrak penyerang ringan seperti Kelly Power 58 atau Orion Power 67), terjadi 80% CATASTROPHIC KNOCKDOWN (jatuh terkapar di rumput) dan 100% bola lepas! Jika -1 <= Delta Power <= 10 (seimbang), target 60% berhasil melindungi bola (ProtectBall).',
    double_teaming_penalty:
      'Ketika pembawa bola ditempel/dikepung oleh 2 pemain lawan (overlap), status benturan memicu debuff kecepatan lari turun drastis ke 90% (OverlapPlayerHasBallRun/Sprint = 0.90) dan benturan bahu terpicu tiap 0.5 detik. Menahan bola saat dikepung 2 bek hampir pasti 100% kehilangan bola.',
    energy_and_stamina_rules:
      'Energi Ulti pulih pasif 3.0/detik + bonus aksi (Bek dapat +20 Energi saat tekel sukses, Penyerang dapat +20 saat loose shoot). Stamina (600-1200) pulih 320-450/detik; lari tanpa bola gratis 0 stamina, tapi sprint dribble menguras 80 stamina/detik. Habis stamina memicu status LowStamina (sprint terkunci hingga 400 stamina terisi kembali).',
    goalkeeper_rules:
      'Kiper di kotak penalti memiliki status Invincible saat memegang bola (maks 3.0 detik). Operan balik (back-pass) dari rekan setim hanya bisa ditahan kiper selama 0.3 detik (anti-stall). Kiper keluar kotak penalti kehilangan hak sarung tangan.',
    final_play_rule:
      'Ketika timer matchday mencapai 00:00 namun serangan tim masih aktif menuju gawang (Final Play / Serangan Terakhir), wasit tidak meniup peluit sampai bola berhasil dibuang atau gol tercipta.',
  },
  characters: [
    {
      id: 1003,
      name: 'Andrew',
      localized_name: '安德鲁',
      role: 'CB',
      power: 87,
      speed: 76,
      stamina: 84,
      shoot: 59,
      pass: 72,
      dribble: 61,
      defense: 82,
      small_skill: {
        name: 'Shoulder Barge',
        in_game_name_id: 'Shoulder Charge',
        cost_type: 'Stamina',
        cost_val: 400,
        description: 'Benturan bahu jarak dekat (2.0m) dengan kekuatan tertinggi di game (87 Power). Memicu 80% Knockdown instan pada penyerang ringan.',
      },
      ultimate_skill: {
        name: 'Anchor Sweep / Super Tackle',
        in_game_name_id: 'Super Tackle',
        cost_energy: 420,
        range_or_duration: '18.0 meter',
        description: 'Meluncur tekel sejauh 18 meter! Kontak dengan pembawa bola memicu ControlBallImmediately (bola otomatis lengket di kaki Andrew, tak terbantahkan) + lawan jatuh terkapar.',
      },
      key_passives: [
        'Power Press (1003101): Push menjatuhkan pemain dengan Strength rendah.',
        'Tracking Slide (1003102): Memungkinkan umpan atau tembakan langsung seketika setelah merebut bola dengan tekel atau Super Tackle.',
        'Bulldog Slide (3009): Otomatis menghadapkan badan ke arah bola saat melakukan Sliding Tackle.',
        'Silent Zone (3030): Menurunkan kecepatan gerak lawan di sekitar sebesar 15% dan tendangan sebesar 10.',
      ],
      playstyle_summary: 'Bek perusak (Enforcer). Rajanya tekel jarak jauh 18 meter dan body check brutal. Sangat mematikan untuk menghentikan serangan balik cepat.',
    },
    {
      id: 1009,
      name: 'Ford',
      localized_name: '福特',
      role: 'CB',
      power: 79,
      speed: 80,
      stamina: 78,
      shoot: 58,
      pass: 69,
      dribble: 58,
      defense: 84,
      small_skill: {
        name: 'Shoulder Barge',
        in_game_name_id: 'Shoulder Charge',
        cost_type: 'Stamina',
        cost_val: 400,
        description: 'Body check kokoh (79 Power) jarak 2.0m, mengunci laju penyerang yang mencoba menerobos.',
      },
      ultimate_skill: {
        name: 'Iron Wall / Super Block',
        in_game_name_id: 'Super Block',
        cost_energy: 380,
        range_or_duration: 'Durasi 4.0 detik',
        description: 'Memasang barikade pertahanan mutlak (Buff 1009020). Bola tembakan/umpan yang mengarah ke jalurnya seketika dihentikan mati (StopFreeMoveBall) dan disapu bersih ke depan.',
      },
      key_passives: [
        'Precise Deflection (1009101): Memperluas jangkauan blok bola saat posisi bertahan sebesar 10% dan membelokkan bola ke rekan tim terdekat.',
        'Charging Shield (1009102): Setelah Ultimate berhasil memblokir tembakan lawan, seluruh tim secara instan memulihkan 12% Energy.',
        'Relentless Press (3020): Memulihkan 350 Stamina setelah tackle yang sukses.',
        'Precision Tackle (3022): Otomatis menghadapkan badan ke arah bola saat melakukan Standing Tackle.',
      ],
      playstyle_summary: 'Bek dinding kokoh (Wall Blocker). Menutup semua sudut shooting dan passing lawan. Duet paling ditakuti bersama Andrew.',
    },
    {
      id: 1001,
      name: 'Orion',
      localized_name: '奥利恩',
      role: 'ST',
      power: 67,
      speed: 70,
      stamina: 70,
      shoot: 81,
      pass: 67,
      dribble: 74,
      defense: 55,
      small_skill: {
        name: 'Orion Pull / Stepover',
        in_game_name_id: 'Gocek (Stepover)',
        cost_type: 'Stamina',
        cost_val: 320,
        description: 'Teknik drag-back & stepover khas untuk mengecoh tekel geser bek dan membatalkan animasi tendangan.',
      },
      ultimate_skill: {
        name: 'Skyfall Kick / Bicycle Kick',
        in_game_name_id: 'Bicycle Kick',
        cost_energy: 530,
        range_or_duration: 'Aerial Volley',
        description: 'Tendangan salto spektakuler. Bola mendapat Buff kebal tekel (5.0s) & kebal intersep (1.63s). Arah tembakan pojok bisa diarahkan manual via swipe.',
      },
      key_passives: [
        'Parade Rush (1001101): Setelah Gocek, protected lunge menempuh jarak lebih jauh dan joystick kiri dapat mengontrol arah charge.',
        'Scope In (1001102): Memungkinkan bidikan ke gawang lebih akurat serta menaikkan kecepatan dan jarak tempuh bola sebesar 20%.',
        'Box Predator (3003): Kebal dari knockdown dan gangguan selama 2 detik saat menerima bola di dalam kotak penalti lawan.',
        'Low Bullet (3001): Menaikkan kecepatan ground shot sebesar 20%.',
      ],
      playstyle_summary: 'Target man mematikan di kotak penalti. Spesialis umpan lambung dan eksekusi salto yang tak bisa dihentikan di udara.',
    },
    {
      id: 1002,
      name: 'Hayato',
      localized_name: '夜神隼',
      role: 'CM',
      power: 72,
      speed: 71,
      stamina: 74,
      shoot: 70,
      pass: 77,
      dribble: 81,
      defense: 63,
      small_skill: {
        name: 'Hayato Pull / Dual Drag',
        in_game_name_id: 'Drag',
        cost_type: 'Stamina',
        cost_val: 160,
        description: 'Drag-back gesit berbiaya rendah untuk menggocek lawan dalam ruang sempit dan membatalkan animasi tendangan instan.',
      },
      ultimate_skill: {
        name: 'Flash Step / Super Dribble',
        in_game_name_id: 'Super Dribble',
        cost_energy: 320,
        range_or_duration: 'Radius 8.0m, kerucut 120 derajat',
        description: 'Gerakan dribble kilat berantai yang dapat melewati hingga 3 pemain lawan berturut-turut tanpa bisa direbut dari depan.',
      },
      key_passives: [
        'Dynamic Footwork (1002101): Dual Drag dapat membatalkan tendangan secara instan.',
        'Attribute Siphon (1002102): Untuk setiap lawan yang dikalahkan oleh Ultimate, pemain mendapat +2 ke semua atribut dan lawan kehilangan 2 atribut selama 30 detik.',
        'Untouchable Drag (3005): Mengurangi peluang kehilangan bola saat menggunakan Skill Moves.',
        'Comeback Drive (3007): Untuk tiap gol yang tertinggal, seluruh tim mendapatkan +1 atribut Kontrol Bola dan Shooting.',
      ],
      playstyle_summary: 'Playmaker penggiring bola licin. Sangat efektif membongkar garis tengah dan memecah formasi bertahan lawan.',
    },
    {
      id: 1004,
      name: 'Kelly',
      localized_name: '凯莉',
      role: 'WF',
      power: 58,
      speed: 80,
      stamina: 66,
      shoot: 72,
      pass: 76,
      dribble: 78,
      defense: 54,
      small_skill: {
        name: 'Push Ball / Knock-on',
        in_game_name_id: 'Knock (Knock-On)',
        cost_type: 'Stamina',
        cost_val: 150,
        description: 'Dorongan bola ke depan disertai akselerasi sprint eksplosif meninggalkan penjagaan bek.',
      },
      ultimate_skill: {
        name: 'Ultra Velocity / Wall Dash',
        in_game_name_id: 'Wall Dash',
        cost_energy: 440,
        range_or_duration: 'Lompat 15m, elevasi 1.8m, ekstensi 8m',
        description: 'Lompat dan berlari di dinding stadion! Sepenuhnya kebal terhadap tekel rumput dan langsung diakhiri dengan tendangan voli menyilang ke gawang.',
      },
      key_passives: [
        'Aerial Knock-On (1004101): Knock dapat menurunkan bola tinggi yang masuk seketika ke kaki.',
        'Desperate Breakout (1004102): Saat bola dekat dengan dinding, Knock-on dapat memantul dari dinding untuk merebutnya kembali.',
        'Swift Burst (3014): Meningkatkan kecepatan gerak sebesar 12% selama 1.5 detik setelah melakukan Knock-on.',
        'Final Form (3039): Mengaktifkan Ultimate meningkatkan seluruh atribut sebanyak +9 selama 30 detik.',
      ],
      playstyle_summary: 'Sayap pelari cepat (Speed Demon). Mengandalkan kecepatan tepi lapangan dan trik dinding stadion yang mustahil dijangkau tekel biasa.',
    },
    {
      id: 1006,
      name: 'Shirou',
      localized_name: '士郎',
      role: 'ST',
      power: 71,
      speed: 75,
      stamina: 71,
      shoot: 73,
      pass: 76,
      dribble: 79,
      defense: 56,
      small_skill: {
        name: 'Rainbow Flick',
        in_game_name_id: 'Rainbow Flick',
        cost_type: 'Stamina',
        cost_val: 175,
        description: 'Mencungkil bola melewati kepala bek yang sedang meluncur tekel.',
      },
      ultimate_skill: {
        name: 'Dual Impact / Dual Shoot',
        in_game_name_id: 'Dual Shoot',
        cost_energy: 390,
        range_or_duration: 'Aura 10 detik',
        description: 'Tembakan kombinasi kembar dengan efek ledakan AoE Knockdown / Hit-Fly yang melempar jatuh siapa pun pemain di jalur lintasannya.',
      },
      key_passives: [
        'Aerial Duo (1006101): Saat posisi bola tinggi, shooting tanpa bola langsung memanggil rekan tim terdekat untuk tendangan salto berdua di udara.',
        'Rainbow Spectrum (1006102): QTE Rainbow Flick sempurna mengirim bola lebih tinggi dan membuatnya lebih sulit ditekel.',
        'Power Bond (3017): Menaikkan Shot Power sebesar 15, efek ini dibagi ke rekan setim yang ikut dalam Dual Impact.',
        'Relentless Strike (3002): Setelah tembakan ditepis kiper, tembakan berikutnya mendapat +30 Shot Power.',
      ],
      playstyle_summary: 'Striker serba bisa dengan tendangan melengkung akurat dan tembakan ulti yang mendisrupsi pertahanan.',
    },
    {
      id: 1007,
      name: 'Rafael',
      localized_name: '拉斐尔',
      role: 'ST',
      power: 75,
      speed: 66,
      stamina: 72,
      shoot: 82,
      pass: 77,
      dribble: 69,
      defense: 49,
      small_skill: {
        name: 'Cut Turn',
        in_game_name_id: 'Cut Turn',
        cost_type: 'Stamina',
        cost_val: 250,
        description: 'Pembalikan badan tajam menggunakan tumit untuk membuka ruang tembak seketika.',
      },
      ultimate_skill: {
        name: 'Super Fake Shoot',
        in_game_name_id: 'Super Fake Shoot',
        cost_energy: 460,
        range_or_duration: 'Durasi 10 detik',
        description: 'Melakukan 2 kali gerakan tipuan tembakan berturut-turut dengan Super Armor; membuat bek lawan oleng/stagger lalu melepas tembakan gledek (+20 Energi pada loose shot).',
      },
      key_passives: [
        'Turn Feint (1007101): Cut Turn dapat membatalkan tendangan dan secara otomatis merangkai ke Super Shot.',
        'Fake Shot Pass (1007102): Membatalkan Ultimate dengan umpan memulihkan 30% Ultimate Energy dan membuat lawan di sekitar kehilangan keseimbangan.',
        'Power Shot (3026): Kecepatan tembakan naik 10% dan penurunan bola saat di udara berkurang 10%.',
        'Flair Finisher (3024): Selalu melakukan Rabona saat menembak sambil membawa bola di dekat kotak penalti lawan.',
      ],
      playstyle_summary: 'Sniper & master tipuan (Apex Hunter). Spesialis menghukum bek yang terburu-buru melakukan diving tackle.',
    },
    {
      id: 1008,
      name: 'Moco',
      localized_name: '莫科',
      role: 'CM',
      power: 67,
      speed: 76,
      stamina: 72,
      shoot: 67,
      pass: 78,
      dribble: 77,
      defense: 61,
      small_skill: {
        name: 'One-Two Pass',
        in_game_name_id: 'One-Two Pass',
        cost_type: 'Stamina',
        cost_val: 100,
        description: 'Umpan satu-dua instan (radius scan 25-50m) yang membutakan fokus kamera lawan selama 2 detik.',
      },
      ultimate_skill: {
        name: 'Hacker Mark / Precision Protocol',
        in_game_name_id: 'Hacker Mark',
        cost_energy: 380,
        range_or_duration: 'Durasi 20 detik',
        description: 'Mengaktifkan radar presisi global ke seluruh tim; operan menjadi auto-target akurat melintasi seluruh penjuru lapangan.',
      },
      key_passives: [
        'Penetrating Short Pass (3051): Umpan ke rekan tim yang terkunci tidak dapat diblok selama 0.3 detik pertama.',
        'Passing Vision (3060): Meningkatkan jangkauan automatic-pass ke rekan tim sebesar 10 meter.',
        'Best Teammate (3044): Setelah mengumpan ke rekan tim, atribut Shooting mereka bertambah +8 selama 3 detik.',
        'One-Touch Pass (3053): Umpan sentuhan pertama bergerak 10% lebih cepat.',
      ],
      playstyle_summary: 'Jenderal lapangan tengah (Tactical Maestro). Mengatur ritme permainan dan membagi bola dengan akurasi radar tanpa cela.',
    },
    {
      id: 1010,
      name: 'Homer',
      localized_name: '赫马',
      role: 'CM',
      power: 72,
      speed: 70,
      stamina: 75,
      shoot: 73,
      pass: 84,
      dribble: 74,
      defense: 60,
      small_skill: {
        name: 'Elastico',
        in_game_name_id: 'Elastico',
        cost_type: 'Stamina',
        cost_val: 160,
        description: 'Gerakan tipuan elastico yang memberikan efek counter-stun bila ditekel lawan saat dieksekusi.',
      },
      ultimate_skill: {
        name: 'Full Vision',
        in_game_name_id: 'Full Vision',
        cost_energy: 280,
        range_or_duration: 'Durasi 60 detik (Cost terendah)',
        description: 'Sudut pandang taktis luas; bola tembakan/lemparan berubah menjadi proyektil homing yang membelok mencari target dengan radius kunci 16.0 meter.',
      },
      key_passives: [
        'Dragon\'s Flight (1010101): Saat Full Vision aktif, geser layar untuk mengontrol lintasan lengkung bola lambung.',
        'Elastico Dash (1010102): Memperpanjang jendela counter Elastico; counter sukses otomatis memicu Dash menjauh dari bek.',
        'Sustained Vision (3031): Tiap umpan atau tembakan saat Full Vision menambah durasinya sebesar 4 detik.',
        'Aerial Guidance (3029): Saat menggunakan Umpan Lob, kecepatan bola naik 5% dan kecepatan jatuhnya bola naik 20%.',
      ],
      playstyle_summary: 'Playmaker umpan lambung dan proyektil berpandu (Pulse Master). Ultinya paling murah dan cepat terisi kembali.',
    },
    {
      id: 1011,
      name: 'Oscar',
      localized_name: '奥斯卡',
      role: 'ST',
      power: 78,
      speed: 75,
      stamina: 77,
      shoot: 73,
      pass: 71,
      dribble: 75,
      defense: 58,
      small_skill: {
        name: 'Two Point Sprint',
        in_game_name_id: 'Sprint Terjang',
        cost_type: 'Stamina',
        cost_val: 300,
        description: 'Sprint terjang fisik yang mendorong mundur lawan di depannya.',
      },
      ultimate_skill: {
        name: 'Savage Dash',
        in_game_name_id: 'Savage Dash',
        cost_energy: 320,
        range_or_duration: 'Durasi 5.3 detik',
        description: 'Lari terjang tak terbendung yang menabrak dan menjatuhkan semua pemain di jalurnya; kecepatan tembakan bertambah seiring durasi lari.',
      },
      key_passives: [
        'Poacher\'s Instinct (3056): Meningkatkan Ball-Winning sebesar +6 di dalam kotak penalti lawan.',
        'Tight-Angle Expert (3057): Tembakan dari sudut sempit melaju 10% lebih cepat dan menukik tajam.',
        'Power Through (3055): Strength bertambah +6 dan kecepatan gerak naik 10% saat melakukan push.',
        'Super Fitness (3046): Menaikkan Shot Power sebesar 10 selama 3 detik setelah memakai Dash.',
      ],
      playstyle_summary: 'Striker badak perusak pertahanan. Menerobos garis belakang lawan dengan kekuatan fisik murni.',
    },
    {
      id: 1012,
      name: 'Steffie',
      localized_name: '史黛菲',
      role: 'CB',
      power: 75,
      speed: 81,
      stamina: 78,
      shoot: 55,
      pass: 78,
      dribble: 59,
      defense: 79,
      small_skill: {
        name: 'Double Tackle',
        in_game_name_id: 'Slide Ganda',
        cost_type: 'Stamina',
        cost_val: 320,
        description: 'Dua tekel luncur berantai tanpa jeda pemulihan di tanah; jika tekel pertama luput, tekel kedua langsung menyambar.',
      },
      ultimate_skill: {
        name: 'Doodle Storm',
        in_game_name_id: 'Doodle Storm',
        cost_energy: 360,
        range_or_duration: 'Durasi 10 detik',
        description: 'Memberi boost kecepatan tim selama 3 detik + mengaktifkan fitur Dual Slide (tekel ganda) untuk seluruh rekan setim selama 10 detik!',
      },
      key_passives: [
        'Countercharge (3010): Meningkatkan Sliding Tackle sebesar 6; sukses merebut bola memberi tambahan speed 20% ke seluruh tim selama 2.5 detik.',
        'Home Turf (3011): Mengurangi konsumsi Stamina sebesar 30% saat berada di paruh lapangan sendiri.',
        'Overdrive Flash (3050): Saat Ultimate aktif, semua rekan tim mendapatkan tambahan 15% movement speed.',
        'Solid Rock (3011): Jockey Speed 87, Scramble 86, Bek tercepat di game.',
      ],
      playstyle_summary: 'Bek penyapu modern berkecepatan tinggi (Graffiti Guardian). Ahli menutup celah dan memberikan buff bertahan kolektif bagi tim.',
    },
    {
      id: 1013,
      name: 'Tatsuya',
      localized_name: '达也',
      role: 'WF',
      power: 59,
      speed: 81,
      stamina: 71,
      shoot: 67,
      pass: 70,
      dribble: 74,
      defense: 71,
      small_skill: {
        name: 'Dash',
        in_game_name_id: 'Dash',
        cost_type: 'None',
        cost_val: 0,
        description: 'Dash cepat GRATIS (0 Stamina, 0 Energy, CD 5.5 detik) untuk perpindahan posisi kilat.',
      },
      ultimate_skill: {
        name: 'Shadow Shuttle / Super Dash',
        in_game_name_id: 'Shadow Rush',
        cost_energy: 390,
        range_or_duration: 'Multi-dash beruntun',
        description: 'Manuver zig-zag beruntun dengan potongan sudut instan; mendapat bonus +1 dash tambahan bila dieksekusi di sektor sayap.',
      },
      key_passives: [
        'Steady Stride (3034): Memakai Dash berpeluang 50% mengurangi cooldown-nya sebesar 3 detik.',
        'Meteor Stride (3037): Mengaktifkan Dash memberi tambahan speed boost 10% dan berpeluang 20% tidak memakai charge Dash.',
        'Dash Momentum (3061): Umpan atau shooting tepat setelah Dash mengurangi cooldown Dash sebesar 3 detik.',
        'Adaptability (3047): Saat tim seri/unggul regen stamina +8; saat tertinggal akurasi tendangan +8.',
      ],
      playstyle_summary: 'Sayap lincah counter-attack (Shadow Rush). Sangat mobile berkat dash tanpa biaya stamina.',
    },
    {
      id: 1005,
      name: 'Maxim',
      localized_name: '马克西姆',
      role: 'GK',
      power: 100,
      speed: 80,
      stamina: 81,
      shoot: 80,
      pass: 87,
      dribble: 75,
      defense: 75,
      small_skill: {
        name: 'Smother Tackle / Dive Saves',
        in_game_name_id: 'Selip (Dive) / Tangkap',
        cost_type: 'None',
        cost_val: 0,
        description: 'Repertoar penyelamatan komprehensif: tangkapan bola bawah/atas, tepisan sudut 45/67 derajat, dan tekel pengaman bola lepas.',
      },
      ultimate_skill: {
        name: 'Goal Clearance / Distribution',
        in_game_name_id: 'Umpan / Sapuan Gawang',
        cost_energy: 0,
        range_or_duration: 'Kotak Penalti',
        description: 'Pembersihan bola instan dengan operan atau tendangan jauh akurat (100 Strength & 87 Pass).',
      },
      key_passives: [
        'Invincible Kotak Penalti: Kebal gangguan saat memegang bola maksimal 3.0 detik.',
        'Anti-Stall Backpass: Hanya boleh menahan bola back-pass rekan selama 0.3 detik sebelum wajib dilepas.',
        'Clearance 90: Kekuatan tendangan sapuan tertinggi menjauhkan bola dari zona bahaya.',
      ],
      playstyle_summary: 'Kiper tangguh pengawal mistar gawang.',
    },
  ],
  all_passive_skills: {
    '3001': 'Low Bullet: Menaikkan kecepatan ground shot sebesar 20%',
    '3002': 'Relentless Strike: Setelah tembakan ditepis kiper, tembakan berikutnya mendapat +30 Shot Power',
    '3003': 'Box Predator: Kebal knockdown & gangguan selama 2 detik saat menerima bola di dalam kotak penalti lawan',
    '3004': 'Momentum Surge: Saat rekan tim mencetak gol, langsung mendapatkan 20% Ultimate Energy',
    '3005': 'Untouchable Drag: Mengurangi peluang kehilangan bola saat memakai Skill Moves',
    '3006': 'Thread the Needle: Meningkatkan kecepatan bola sebesar 10% saat menekan rekan setim untuk mengumpan',
    '3007': 'Comeback Drive: Untuk tiap gol yang tertinggal, seluruh tim mendapat +1 Kontrol Bola & Shooting',
    '3009': 'Bulldog Slide: Otomatis menghadapkan badan ke arah bola saat melakukan Sliding Tackle',
    '3010': 'Countercharge: Meningkatkan Sliding Tackle sebesar 6. Sukses tekel beri speed +20% ke seluruh tim 2.5s',
    '3011': 'Home Turf: Mengurangi konsumsi Stamina sebesar 30% di separuh lapangan sendiri',
    '3012': 'Sticky Slide: Saat tekel kena dan tak ada lawan dalam 3m, ada peluang 60% bola tetap di kaki',
    '3013': 'Fluid Core: Saat kena tackle, ada peluang 50% untuk tidak jatuh',
    '3014': 'Swift Burst: Meningkatkan kecepatan gerak 12% selama 1.5s setelah melakukan Knock-on',
    '3015': 'Second Wind: Memulihkan 300 Stamina saat dijatuhkan oleh tackle lawan',
    '3016': 'Line Breaker: Dribble speed naik 6. Speed meningkat bertahap hingga 8% di wilayah lawan',
    '3017': 'Power Bond: Menaikkan Shot Power 15 (dibagi ke rekan di Dual Impact)',
    '3018': 'No Mercy: Saat tim mencetak gol, seluruh tim mendapat 15 Ultimate Energy',
    '3020': 'Relentless Press: Memulihkan 350 Stamina setelah tackle sukses',
    '3021': 'Rallying Cry: Saat lawan mencetak gol, seluruh tim memperoleh 15 Ultimate Energy',
    '3022': 'Precision Tackle: Otomatis menghadapkan badan ke arah bola saat Standing Tackle',
    '3024': 'Flair Finisher: Selalu melakukan Rabona saat menembak dekat kotak penalti lawan',
    '3026': 'Power Shot: Kecepatan tembakan naik 10% dan penurunan bola di udara berkurang 10%',
    '3027': 'Skill Link: Menembak tepat setelah Skill Move meningkatkan kecepatan bola 8%',
    '3029': 'Aerial Guidance: Umpan lob melaju 5% lebih cepat dan jatuh 20% lebih tajam',
    '3030': 'Silent Zone: Menurunkan kecepatan gerak lawan sekitar 15% dan tendangan sebesar 10',
    '3031': 'Sustained Vision: Tiap umpan/tembak saat Full Vision menambah durasinya 4 detik',
    '3034': 'Steady Stride: Memakai Dash berpeluang 50% mengurangi cooldown 3s',
    '3037': 'Meteor Stride: Dash memberi speed boost 10% dan peluang 20% tanpa biaya charge',
    '3039': 'Final Form: Memakai Ultimate meningkatkan seluruh atribut +9 selama 30 detik',
    '3044': 'Best Teammate: Setelah mengumpan, Shooting rekan setim bertambah +8 selama 3 detik',
    '3046': 'Super Fitness: Menaikkan Shot Power 10 selama 3s setelah memakai Dash',
    '3047': 'Adaptability: Saat seri/unggul stamina regen +8; saat tertinggal akurasi tembakan +8',
    '3050': 'Overdrive Flash: Saat Ultimate aktif, seluruh tim mendapat tambahan 15% movement speed',
    '3051': 'Penetrating Short Pass: Umpan pendek ke rekan terkunci tidak dapat diblok selama 0.3s pertama',
    '3053': 'One-Touch Pass: Umpan sentuhan pertama meluncur 10% lebih cepat',
    '3055': 'Power Through: Strength +6 dan kecepatan gerak +10% saat melakukan push',
    '3056': 'Poacher\'s Instinct: Ball-Winning +6 di dalam kotak penalti',
    '3057': 'Tight-Angle Expert: Tembakan sudut sempit 10% lebih cepat dan menukik tajam',
    '3060': 'Passing Vision: Menambah jangkauan auto-pass ke rekan setim sebesar 10 meter',
    '3061': 'Dash Momentum: Umpan/tembak tepat setelah Dash memangkas cooldown Dash 3 detik',
  },
  tactical_matchup_playbook: {
    'dikepung_andrew_dan_ford':
      'Skenario: Paling berbahaya di Flash Peak! Andrew punya Shoulder Charge (87 Power, 80% Knockdown) & Super Tackle 18m, sedangkan Ford punya Super Block (bola langsung mati). Strategi:\n1. JANGAN mendribble atau menahan bola — status overlap membuat lari melambat ke 90% dan memicu tabrakan bahu tiap 0.5 detik.\n2. Lakukan operan kilat 1-2 sentuhan (One-Two) ke ruang kosong SEBELUM jarak mendekat < 2 meter.\n3. Karena 2 bek lawan menempel pada 1 pemain, artinya ada 1 atau 2 rekan setimmu yang BEBAS tanpa kawalan (keunggulan jumlah di area lain).\n4. Gunakan umpan silang jauh (diagonal/lob pass) ke sayap kosong (Kelly/Tatsuya) atau cari posisi tembak di blindspot Ford.',
    'counter_orion':
      'Orion mematikan lewat Bicycle Kick (kebal tekel & intersep saat di udara). Cara counter: Matikan suplayer bola — potong umpan lambung sebelum masuk kotak penalti. Jika bola sudah melambung ke Orion, jangan buang stamina meluncur tekel karena dia kebal; sebaliknya posisikan bek (Ford/Andrew) tepat di garis gawang untuk memblokir arah tembakan setelah bola turun.',
    'counter_hayato':
      'Hayato punya Super Dribble dengan kerucut 120 derajat sejauh 8 meter yang melewati pemain depan. Cara counter: Jaga jarak jockey (Defend/Joki stance > 2m) dan jangan buru-buru sliding tackle dari depan. Biarkan dia menyelesaikan dash-nya, lalu sergap menggunakan Shoulder Barge dari arah samping/flank, atau pasang Super Block Ford tepat di jalurnya.',
    'counter_kelly':
      'Kelly mengandalkan Wall Dash 15m di dinding stadion yang kebal tekel rumput. Cara counter: Jangan ikut mengejar ke pinggir dinding (itu perangkap). Tetap kawal area tengah dan tiang jauh gawang. Tunggu Kelly mendarat dari dinding, lalu hantam dengan tekel Andrew saat animasi pendaratannya selesai.',
    'counter_rafael':
      'Rafael punya Super Fake Shoot dengan Super Armor yang membuat bek oleng jika buru-buru tekel. Cara counter: Tetap sabar dalam posisi jockey stance (Defend button) tanpa menekan tekel saat dia melakukan 2 tipuan pertama. Tekel baru dilepaskan saat animasi tendangan aslinya dimulai.',
    'counter_oscar':
      'Oscar punya Savage Dash (lari badak menerjang menjatuhkan semua pemain di depannya). Cara counter: Jangan pernah berdiri menghadang di garis lurus lari Oscar! Menyingkirlah ke samping, biarkan dash-nya terbuang, lalu tekel dari arah belakang/samping saat durasi dash-nya habis (5.3 detik).',
  },
};
