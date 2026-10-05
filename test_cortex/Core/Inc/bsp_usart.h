#ifndef BSP_USART_H
#define BSP_USART_H

#include "main.h"

/*
 * Generic UART DMA receive layer ported from the H7 remote-control structure.
 *
 * STM32F1 has no DMA double-buffer mode (DBM), so this adaptation uses one
 * circular DMA buffer and frames incoming data with the UART IDLE interrupt:
 * every IDLE event reports the bytes received since the previous event.
 * Upper layers only pass a logical UART id and register a protocol callback,
 * so more protocols can be added without touching the hardware layer.
 */

typedef enum
{
  BSP_UART1 = 0,
  BSP_UART2,
  BSP_UART_NUM
} bsp_uart_id_t;

typedef void (*bsp_uart_rx_cb_t)(bsp_uart_id_t uartx, uint8_t *data, uint16_t size);

typedef struct
{
  bsp_uart_id_t uartx;        /* logical UART id */
  uint8_t *buffer;            /* circular DMA receive buffer */
  uint16_t buffer_size;       /* buffer length in bytes (max 64) */
  bsp_uart_rx_cb_t rx_cb;     /* frame callback, may be NULL */
} BSP_UART_DMA_RX_Config;

void bsp_uart_dma_rx_init(const BSP_UART_DMA_RX_Config *cfg);
void bsp_uart_dma_rx_register_cb(bsp_uart_id_t uartx, bsp_uart_rx_cb_t cb);
void bsp_uart_dma_rx_restart(bsp_uart_id_t uartx);
void bsp_uart_dma_rx_stop(bsp_uart_id_t uartx);

#endif
