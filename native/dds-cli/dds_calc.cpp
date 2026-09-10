/* Stepstone CLI adapter for DDS CalcDDtable. */

#include <cstdio>
#include <api/dll.h>

int main()
{
    unsigned int cards[4][4];
    for (int hand = 0; hand < 4; ++hand)
        for (int suit = 0; suit < 4; ++suit)
            if (scanf("%u", &cards[hand][suit]) != 1) return 1;

    DdTableDeal deal{};
    for (int hand = 0; hand < 4; ++hand)
        for (int suit = 0; suit < 4; ++suit)
            deal.cards[hand][suit] = cards[hand][suit];

    DdTableResults table{};
    const int result = CalcDDtable(deal, &table);
    if (result != RETURN_NO_FAULT) {
        char message[80];
        ErrorMessage(result, message);
        fprintf(stderr, "DDS error: %s\n", message);
        return result;
    }

    for (int strain = 0; strain < 5; ++strain)
        for (int hand = 0; hand < 4; ++hand)
            printf("%d ", table.res_table[strain][hand]);
    printf("\n");
    return 0;
}
