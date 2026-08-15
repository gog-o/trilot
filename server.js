const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let players = [];
let gameState = {
    deck: [],
    hands: {},
    roundScores: {},
    announcements: {},
    totalScores: {},
    announcer: null,
    gameType: null,
    currentTrick: [],
    currentTurnIndex: 0,
    dealerIndex: -1,
    ledSuit: null,
    phase: 'WAITING',
    highestBid: { type: null, value: 0, playerId: null },
    passCount: 0
};

const bidValues = { '♦': 1, '♥': 2, '♠': 3, 'БЕЗ_КОЗ': 4, 'ВСИЧКО_КОЗ': 5 };

function createDeck() {
    const suits = ['♦', '♥', '♠'];
    const values = ['3', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let suit of suits) {
        for (let value of values) deck.push({ value, suit });
    }
    return deck;
}

function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// ПРАВИЛО: Йерархия на картите по сила (Тройката винаги е най-слаба = сила 0)
function getCardPower(card, ledSuit, gameType) {
    const value = card.value;
    const isSuitMatch = card.suit === ledSuit;
    if (value === '3') return isSuitMatch ? 1 : 0; // Тройката в цвета на ръката бие само тройки в чужд цвят

    if (gameType === 'ВСИЧКО_КОЗ' || (gameType === 'БОЯ' && card.suit === gameType)) {
        // Козова подредба: J (9), 9 (8), A (7), 10 (6), K (5), Q (4), 8 (3), 7 (2)
        const powerMap = { '7': 2, '8': 3, 'Q': 4, 'K': 5, '10': 6, 'A': 7, '9': 8, 'J': 9 };
        return isSuitMatch ? powerMap[value] : 0;
    } else {
        // Без коз / Световна подредба: A (9), 10 (8), K (7), Q (6), J (5), 9 (4), 8 (3), 7 (2)
        const powerMap = { '7': 2, '8': 3, '9': 4, 'J': 5, 'Q': 6, 'K': 7, '10': 8, 'A': 9 };
        return isSuitMatch ? powerMap[value] : 0;
    }
}

// ТОЧКУВАНЕ СЪГЛАСНО ВАШИТЕ УКАЗАНИЯ
function getStandardCardPoints(card, gameType, ledSuit) {
    const value = card.value;
    
    // Специфична обработка за уникалната тройка
    if (value === '3') {
        if (gameType === 'БЕЗ_КОЗ') return 0;
        if (gameType === 'ВСИЧКО_КОЗ') {
            return (card.suit === ledSuit) ? 3 : 9; // 3 точки ако отговори, 9 за наказание ако избяга
        }
        // Ако се играе на единична боя (♦, ♥, ♠)
        return 3; 
    }

    // 1. Точкуване на ВСИЧКО КОЗ
    if (gameType === 'ВСИЧКО_КОЗ') {
        const points = { '7': 0, '8': 0, '9': 14, 'J': 20, 'Q': 3, 'K': 4, '10': 10, 'A': 11 };
        return points[value] || 0;
    }

    // 2. Точкуване на ЕДИНИЧНА БОЯ (Козов цвят срещу Некозов цвят)
    if (['♦', '♥', '♠'].includes(gameType)) {
        if (card.suit === gameType) { // Козов цвят
            const points = { '7': 0, '8': 0, '9': 14, 'J': 20, 'Q': 3, 'K': 4, '10': 10, 'A': 11 };
            return points[value] || 0;
        } else { // Некозов цвят (съвпада изцяло с Без Коз)
            const points = { '7': 1, '8': 1, '9': 1, 'J': 2, 'Q': 3, 'K': 4, '10': 10, 'A': 11 };
            return points[value] || 0;
        }
    }

    // 3. Точкуване на БЕЗ КОЗ
    if (gameType === 'БЕЗ_КОЗ') {
        const points = { '7': 1, '8': 1, '9': 1, 'J': 2, 'Q': 3, 'K': 4, '10': 10, 'A': 11 };
        return points[value] || 0;
    }

    return 0;
}

function evaluateAnnouncements(hand, gameType) {
    let points = 0;
    let counts = {};
    hand.forEach(c => counts[c.value] = (counts[c.value] || 0) + 1);
    for (let val in counts) {
        if (counts[val] === 3) {
            if (val === '3' && gameType === 'БЕЗ_КОЗ') points += 33;
            else if (['10', 'Q', 'K', 'A'].includes(val)) points += 40;
            else if (val === '9') points += 50;
            else if (val === 'J') points += 60;
        }
    }
    return points;
}

function startNewRound() {
    gameState.deck = shuffle(createDeck());
    gameState.currentTrick = [];
    gameState.ledSuit = null;
    gameState.phase = 'BIDDING';
    gameState.highestBid = { type: null, value: 0, playerId: null };
    gameState.passCount = 0;

    if (gameState.dealerIndex === -1) {
        gameState.dealerIndex = Math.floor(Math.random() * 3);
    } else {
        gameState.dealerIndex = (gameState.dealerIndex + 2) % 3;
    }

    players.forEach(id => {
        gameState.hands[id] = [];
        gameState.roundScores[id] = 0;
        gameState.announcements[id] = 0;
        if (gameState.totalScores[id] === undefined) gameState.totalScores[id] = 0;
    });

    let currentDealIndex = (gameState.dealerIndex + 2) % 3; 
    for (let k = 0; k < 3; k++) {
        let pId = players[currentDealIndex];
        gameState.hands[pId].push(...gameState.deck.splice(0, 6));
        currentDealIndex = (currentDealIndex + 2) % 3;
    }

    gameState.currentTurnIndex = (gameState.dealerIndex + 2) % 3;
    sendGameStateToAll();
}

function finishDealing() {
    gameState.phase = 'PLAYING';
    gameState.gameType = gameState.highestBid.type;
    gameState.announcer = gameState.highestBid.playerId;

    let currentDealIndex = (gameState.dealerIndex + 2) % 3;
    for (let k = 0; k < 3; k++) {
        let pId = players[currentDealIndex];
        gameState.hands[pId].push(...gameState.deck.splice(0, 3));
        gameState.announcements[pId] = evaluateAnnouncements(gameState.hands[pId], gameState.gameType);
        currentDealIndex = (currentDealIndex + 2) % 3;
    }

    gameState.currentTurnIndex = players.indexOf(gameState.announcer);
    sendGameStateToAll();
}

function sendGameStateToAll() {
    players.forEach((id, index) => {
        io.to(id).emit('gameState', {
            hand: gameState.hands[id],
            yourIndex: index,
            currentTrick: gameState.currentTrick,
            currentTurn: players[gameState.currentTurnIndex],
            totalScores: gameState.totalScores,
            gameType: gameState.gameType,
            announcer: gameState.announcer,
            phase: gameState.phase,
            highestBid: gameState.highestBid,
            dealer: players[gameState.dealerIndex]
        });
    });
}

function processEndRound() {
    let finalScoresThisRound = {};
    players.forEach(id => {
        finalScoresThisRound[id] = gameState.roundScores[id] + gameState.announcements[id];
    });

    if (gameState.gameType === 'БЕЗ_КОЗ') {
        players.forEach(id => finalScoresThisRound[id] *= 2);
    }

    const announcerId = gameState.announcer;
    const announcerPoints = finalScoresThisRound[announcerId];

    let isInside = false;
    players.forEach(id => {
        if (id !== announcerId && finalScoresThisRound[id] > announcerPoints) isInside = true;
    });

    if (isInside) {
        const bonus = Math.floor(announcerPoints / 2);
        players.forEach(id => {
            if (id === announcerId) gameState.totalScores[id] += 0;
            else gameState.totalScores[id] += finalScoresThisRound[id] + bonus;
        });
    } else {
        players.forEach(id => gameState.totalScores[id] += finalScoresThisRound[id]);
    }

    let winner = null;
    players.forEach(id => {
        if (gameState.totalScores[id] >= 111) {
            if (!winner || gameState.totalScores[id] > gameState.totalScores[winner]) winner = id;
        }
    });

    if (winner) {
        io.emit('gameOver', { winner, scores: gameState.totalScores });
        players.forEach(id => gameState.totalScores[id] = 0);
        gameState.dealerIndex = -1;
    } else {
        io.emit('roundOver', { scores: gameState.totalScores });
        startNewRound();
    }
}

io.on('connection', (socket) => {
    if (players.length < 3) {
        players.push(socket.id);
    } else {
        return socket.disconnect();
    }

    if (players.length === 3) startNewRound();

    socket.on('submitBid', (bidType) => {
        if (gameState.phase !== 'BIDDING' || players[gameState.currentTurnIndex] !== socket.id) return;

        if (bidType === 'ПАС') {
            gameState.passCount++;
            if (gameState.passCount === 3 && !gameState.highestBid.type) {
                startNewRound();
                return;
            } else if (gameState.passCount === 2 && gameState.highestBid.type) {
                finishDealing();
                return;
            }
        } else {
            const bidVal = bidValues[bidType] || 0;
            if (bidVal > gameState.highestBid.value) {
                gameState.highestBid = { type: bidType, value: bidVal, playerId: socket.id };
                gameState.passCount = 0;
            } else {
                socket.emit('errorMsg', 'Трябва да наддадете по-висока игра от текущата!');
                return;
            }
        }

        gameState.currentTurnIndex = (gameState.currentTurnIndex + 2) % 3;
        sendGameStateToAll();
    });

    socket.on('playCard', (cardIndex) => {
        if (gameState.phase !== 'PLAYING') return;
        const playerIndex = players.indexOf(socket.id);
        if (playerIndex !== gameState.currentTurnIndex) return;

        const card = gameState.hands[socket.id][cardIndex];
        
        // ВАЛИДАЦИЯ НА ХОДА: Задължително вдигане/цакане в цвят (Тройката винаги има право на пас умение)
        if (gameState.currentTrick.length > 0 && card.value !== '3') {
            const hasLedSuit = gameState.hands[socket.id].some(c => c.suit === gameState.ledSuit);
            
            // Проверка за отговаряне на боята
            if (hasLedSuit && card.suit !== gameState.ledSuit) {
                socket.emit('errorMsg', 'Длъжен сте да отговорите на искания цвят (или пуснете Тройка)!');
                return;
            }
	    // На козов режим (ВСИЧКО КОЗ или избрана БОЯ), ако се отговаря в боята, вдигането е задължително
        if (gameTypeIsTrump(gameState.gameType, gameState.ledSuit) && card.suit === gameState.ledSuit) {
            // Намиране на най-силната карта на масата до момента
            let highestTrickPower = 0;
            gameState.currentTrick.forEach(item => {
                let p = getCardPower(item.card, gameState.ledSuit, gameState.gameType);
                if (p > highestTrickPower) highestTrickPower = p;
            });

            // Проверка дали играчът притежава по-силна карта в ръката си, която може да убие масата
            const myPower = getCardPower(card, gameState.ledSuit, gameState.gameType);
            const hasStrongerCard = gameState.hands[socket.id].some(c =>
                c.suit === gameState.ledSuit &&
                getCardPower(c, gameState.ledSuit, gameState.gameType) > highestTrickPower
            );

            if (hasStrongerCard && myPower < highestTrickPower) {
                socket.emit('errorMsg', 'Задължително трябва да качите (вдигнете) по-силна карта!');
                return;
            }
        }

        if (gameState.currentTrick.length === 0) gameState.ledSuit = card.suit;

        gameState.hands[socket.id].splice(cardIndex, 1);
        gameState.currentTrick.push({ playerId: socket.id, card });
        gameState.currentTurnIndex = (gameState.currentTurnIndex + 2) % 3;

        // Когато тримата са пуснали своите карти, взятката се прибира
        if (gameState.currentTrick.length === 3) {
            setTimeout(() => {
                let winnerCardItem = gameState.currentTrick[0];
                let maxPower = getCardPower(winnerCardItem.card, gameState.ledSuit, gameState.gameType);

                for (let i = 1; i < 3; i++) {
                    let currentPower = getCardPower(gameState.currentTrick[i].card, gameState.ledSuit, gameState.gameType);
                    if (currentPower > maxPower) {
                        maxPower = currentPower;
                        winnerCardItem = gameState.currentTrick[i];
                    }
                }

                // Изчисляване на точките според новите правила
                let trickPoints = 0;
                gameState.currentTrick.forEach(item => {
                    trickPoints += getStandardCardPoints(item.card, gameState.gameType, gameState.ledSuit);
                });

                const trickWinnerId = winnerCardItem.playerId;
                gameState.roundScores[trickWinnerId] += trickPoints;

                // Победителят води следващата ръка
                gameState.currentTurnIndex = players.indexOf(trickWinnerId);
                gameState.currentTrick = [];
                gameState.ledSuit = null;

                // Проверка дали играта е свършила (проверява активния масив на първия играч)
                const checkPlayerId = players[0];
                if (gameState.hands[checkPlayerId].length === 0) {
                    processEndRound();
                } else {
                    sendGameStateToAll();
                }
            }, 1200);
        }
        sendGameStateToAll();
    });

    socket.on('disconnect', () => {
        players = players.filter(id => id !== socket.id);
        gameState.phase = 'WAITING';
        gameState.dealerIndex = -1;
    });
});

function gameTypeIsTrump(gameType, ledSuit) {
    if (gameType === 'ВСИЧКО_КОЗ') return true;
    if (['♦', '♥', '♠'].includes(gameType) && ledSuit === gameType) return true;
    return false;
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Сървърът на Трилот работи на порт ${PORT}`));
