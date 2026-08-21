
    let bestTriadPlayer = null;
    let bestTriadPoints = -1;
    
    players.forEach(id => {
        allBids[id].triads.forEach(t => {
            if (t.points > bestTriadPoints) {
                bestTriadPoints = t.points;
                bestTriadPlayer = id;
            }
        });
    });

    if (bestTriadPlayer) {
        let totalPts = allBids[bestTriadPlayer].triads.reduce((sum, t) => sum + t.points, 0);
        let txt = allBids[bestTriadPlayer].triads.map(t => t.text).join(', ');
        gameState.announcements[bestTriadPlayer].points += totalPts;
        if (gameState.announcements[bestTriadPlayer].text === "Няма") {
            gameState.announcements[bestTriadPlayer].text = txt;
        } else {
            gameState.announcements[bestTriadPlayer].text += " | " + txt;
        }
    }
}

function assignNamesToPlayers() {
    let availableNames = ["Гого", "Виктор", "Моньо"];
    let shuffledNames = shuffle([...availableNames]);
    players.forEach((id, index) => {
        playerNames[id] = shuffledNames[index];
    });
}

function startNewRound() {
    gameState.deck = shuffle(createDeck());
    gameState.currentTrick = [];
    gameState.ledSuit = null;
    gameState.phase = 'BIDDING';
gameState.highestBid = {
    type: null,
    value: 0,
    playerId: null
};
gameState.passCount = 0;
gameState.lastTrickWinner = null;
gameState.belotDeclared = {};
gameState.totalTricksPlayed = 0;
if (gameState.dealerIndex === -1) {
    gameState.dealerIndex = Math.floor(Math.random() * 3);
} else {
    gameState.dealerIndex = (gameState.dealerIndex + 2) % 3;
}
players.forEach(id => {
    gameState.hands[id] = [];
    gameState.roundScores[id] = 0;
    gameState.announcements[id] = {
        points: 0,
        text: "Няма"
    };
    gameState.belotDeclared[id] = false;
    if (gameState.totalScores[id] === undefined) gameState.totalScores[id] = 0;
});
let currentDealIndex = (gameState.dealerIndex + 2) % 3;
for (let k = 0; k < 3; k++) {
    let pId = players[currentDealIndex];
    gameState.hands[pId].push(...gameState.deck.splice(0, 6));
    sortHand(gameState.hands[pId], 'БЕЗ_КОЗ');
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
        sortHand(gameState.hands[pId], gameState.gameType);
        currentDealIndex = (currentDealIndex + 2) % 3;
    }
    compareAndFinalizeAnnouncements();
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
            dealer: players[gameState.dealerIndex],
            announcementText: gameState.announcements[id] ? gameState.announcements[id].text : "Няма",
            announcementPoints: gameState.announcements[id] ? gameState.announcements[id].points : 0,
            playerNamesMap: playerNames
        });
    });
}

function getPlayerDisplay(id) {
    return playerNames[id] || "Наблюдател";
}

function customRoundScores(scoresMap, gameType) {
    let rounded = {};
    let raw = {
        ...scoresMap
    };
    if (gameType === 'БЕЗ_КОЗ') {
        players.forEach(id => {
            let doubled = (raw[id] || 0) * 2;
            let remainder = doubled % 10;
            rounded[id] = (remainder >= 5) ? Math.ceil(doubled / 10) : Math.floor(doubled / 10);
        });
        return rounded;
    }
    if (gameType === 'ВСИЧКО_КОЗ') {
        let minPlayerId = players.reduce((minId, id) => (raw[id] || 0) < (raw[minId] || 0) ? id : minId, players);
        players.forEach(id => {
            let remainder = (raw[id] || 0) % 10;
            let threshold = (id === minPlayerId) ? 4 : 5;
            rounded[id] = (remainder >= threshold) ? Math.ceil((raw[id] || 0) / 10) : Math.floor((raw[id] || 0) / 10);
        });
        return rounded;
    }
    if (['♦', '♥', '♠'].includes(gameType)) {
        let minPlayerId = players.reduce((minId, id) => (raw[id] || 0) < (raw[minId] || 0) ? id : minId, players);
        players.forEach(id => {
            let remainder = (raw[id] || 0) % 10;
            let threshold = (id === minPlayerId) ? 6 : 5;
            rounded[id] = (remainder >= threshold) ? Math.ceil((raw[id] || 0) / 10) : Math.floor((raw[id] || 0) / 10);
        });
        return rounded;
    }
    players.forEach(id => rounded[id] = Math.round((raw[id] || 0) / 10));
    return rounded;
}

function processEndRound() {
    if (gameState.lastTrickWinner) {
        gameState.roundScores[gameState.lastTrickWinner] += 10;
    }
    let finalScoresThisRound = {};
    players.forEach(id => {
        finalScoresThisRound[id] = (gameState.roundScores[id] || 0) + (gameState.announcements[id].points || 0);
    });
    let roundedScores = customRoundScores(finalScoresThisRound, gameState.gameType);
    const announcerId = gameState.announcer;
    const announcerPoints = roundedScores[announcerId] || 0;
    let isInside = false;
    players.forEach(id => {
        if (id !== announcerId && (roundedScores[id] || 0) > announcerPoints) isInside = true;
    });
    let roundLog = {};
    if (isInside) {
        const bonus = Math.floor(announcerPoints / 2);
        players.forEach(id => {
            if (id === announcerId) {
                roundLog[id] = 0;
            } else {
                roundLog[id] = (roundedScores[id] || 0) + bonus;
                gameState.totalScores[id] += roundLog[id];
            }
        });
    } else {
        players.forEach(id => {
            roundLog[id] = roundedScores[id] || 0;
            gameState.totalScores[id] += roundLog[id];
        });
    }
    let winner = null;
    players.forEach(id => {
        if (gameState.totalScores[id] >= 111) {
            if (!winner || gameState.totalScores[id] > gameState.totalScores[winner]) winner = id;
        }
    });
    if (winner) {
        io.emit('gameOver', {
            winner: getPlayerDisplay(winner),
            scores: gameState.totalScores
        });
        players.forEach(id => gameState.totalScores[id] = 0);
        gameState.dealerIndex = -1;
    } else {
        let details = "Край на разиграването!\n\nТочки от този кръг:\n";
        players.forEach(id => {
            details += getPlayerDisplay(id) + ": +" + (roundLog[id] || 0) + " т. (Общо в мача: " + gameState.totalScores[id] + " т.)\n";
        });
        io.emit('roundOver', {
            details
        });
        startNewRound();
    }
}
io.on('connection', (socket) => {
    if (players.length < 3 && !players.includes(socket.id)) {
        players.push(socket.id);
    } else {
        return socket.disconnect();
    }
    if (players.length === 3) {
        assignNamesToPlayers();
        startNewRound();
    }
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
                gameState.highestBid = {
                    type: bidType,
                    value: bidVal,
                    playerId: socket.id
                };
                gameState.passCount = 0;
            } else {
                socket.emit('errorMsg', 'Трябва да наддадете по-висока игра!');
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
        if (gameState.currentTrick.length > 0 && card.value !== '3') {
            const hasLedSuit = gameState.hands[socket.id].some(c => c.suit === gameState.ledSuit);
            if (hasLedSuit && card.suit !== gameState.ledSuit) {
                socket.emit('errorMsg', 'Длъжен сте да отговорите на искания цвят (или пуснете Тройка)!');
                return;
            }
            if (gameTypeIsTrump(gameState.gameType, gameState.ledSuit) && card.suit === gameState.ledSuit) {
                let highestTrickPower = 0;
                gameState.currentTrick.forEach(item => {
                    let p = getCardPower(item.card, gameState.ledSuit, gameState.gameType);
                    if (p > highestTrickPower) highestTrickPower = p;
                });
                const myPower = getCardPower(card, gameState.ledSuit, gameState.gameType);
                const hasStrongerCard = gameState.hands[socket.id].some(c => c.suit === gameState.ledSuit && getCardPower(c, gameState.ledSuit, gameState.gameType) > highestTrickPower);
                if (hasStrongerCard && myPower <= highestTrickPower) {
                    socket.emit('errorMsg', 'Трябва да качите над най-силната карта на масата!');
                    return;
                }
            }
        }
        if (gameState.gameType !== 'БЕЗ_КОЗ' && !gameState.belotDeclared[socket.id]) {
            const isTrumpCard = (gameState.gameType === 'ВСИЧКО_КОЗ' || card.suit === gameState.gameType);
            if (isTrumpCard && (card.value === 'Q' || card.value === 'K')) {
                const partnerValue = (card.value === 'Q') ? 'K' : 'Q';
                const hasPartner = gameState.hands[socket.id].some(c => c.value === partnerValue && c.suit === card.suit);
                if (hasPartner) {
                    gameState.roundScores[socket.id] += 20;
                    gameState.belotDeclared[socket.id] = true;
                    io.emit('errorMsg', getPlayerDisplay(socket.id) + " обяви БЕЛОТ (+20 т.)!");
                }
            }
        }
        if (gameState.currentTrick.length === 0) gameState.ledSuit = card.suit;
        gameState.hands[socket.id].splice(cardIndex, 1);
        gameState.currentTrick.push({
            playerId: socket.id,
            card
        });
        gameState.currentTurnIndex = (gameState.currentTurnIndex + 2) % 3;
        if (gameState.currentTrick.length === 3) {
            gameState.totalTricksPlayed++;
            setTimeout(() => {
                let winnerCardItem = gameState.currentTrick[0]; // ТОЧНАТА КОРЕКЦИЯ: Сочи към първия елемент
                let maxPower = getCardPower(winnerCardItem.card, gameState.ledSuit, gameState.gameType);
                for (let i = 1; i < 3; i++) {
                    let currentPower = getCardPower(gameState.currentTrick[i].card, gameState.ledSuit, gameState.gameType);
                    if (currentPower > maxPower) {
                        maxPower = currentPower;
                        winnerCardItem = gameState.currentTrick[i];
                    }
                }
                let trickPoints = 0;
                gameState.currentTrick.forEach(item => {
                    trickPoints += getStandardCardPoints(item.card, gameState.gameType, gameState.ledSuit);
                });
                const trickWinnerId = winnerCardItem.playerId;
                gameState.roundScores[trickWinnerId] = (gameState.roundScores[trickWinnerId] || 0) + trickPoints;
                gameState.lastTrickWinner = trickWinnerId;
                gameState.currentTurnIndex = players.indexOf(trickWinnerId);
                gameState.currentTrick = [];
                gameState.ledSuit = null;
                if (gameState.totalTricksPlayed === 9) {
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
        delete playerNames[socket.id];
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
http.listen(PORT, () => console.log("Сървърът на Трилот работи на порт " + PORT));