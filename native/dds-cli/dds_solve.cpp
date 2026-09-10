/* Stepstone CLI adapter for DDS SolveBoard. */

#include <cstdio>
#include <api/dll.h>

int main()
{
    int trump;
    int first;
    int trickLength;
    if (scanf("%d %d %d", &trump, &first, &trickLength) != 3) {
        fprintf(stderr, "dds_solve: failed to read header\n");
        return 1;
    }
    if (trump < 0 || trump > 4 || first < 0 || first > 3
        || trickLength < 0 || trickLength > 3) {
        fprintf(stderr, "dds_solve: invalid header values\n");
        return 1;
    }

    Deal deal{};
    deal.trump = trump;
    deal.first = first;
    for (int index = 0; index < 3; ++index) deal.currentTrickSuit[index] = -1;
    for (int index = 0; index < 3; ++index) deal.currentTrickRank[index] = 0;
    for (int index = 0; index < trickLength; ++index) {
        int suit;
        int rank;
        if (scanf("%d %d", &suit, &rank) != 2) {
            fprintf(stderr, "dds_solve: failed to read trick card %d\n", index);
            return 1;
        }
        deal.currentTrickSuit[index] = suit;
        deal.currentTrickRank[index] = rank;
    }

    for (int hand = 0; hand < 4; ++hand)
        for (int suit = 0; suit < 4; ++suit)
            if (scanf("%u", &deal.remainCards[hand][suit]) != 1) {
                fprintf(stderr, "dds_solve: failed to read remainCards[%d][%d]\n", hand, suit);
                return 1;
            }

    FutureTricks future{};
    const int result = SolveBoard(deal, -1, 2, 1, &future, 0);
    if (result != RETURN_NO_FAULT) {
        char message[80];
        ErrorMessage(result, message);
        fprintf(stderr, "dds_solve DDS error %d: %s\n", result, message);
        return result;
    }

    const int score = future.cards > 0 ? future.score[0] : 0;
    printf("%d %d", score, future.cards);
    for (int index = 0; index < future.cards; ++index)
        printf(" %d %d", future.suit[index], future.rank[index]);
    printf("\n");
    return 0;
}
