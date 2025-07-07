import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttemptsController } from './attempts.controller';
import { AttemptsService } from './attempts.service';
import { TestAttempt } from '../tests/entities/test-attempt.entity';
import { TestQuestion } from '../tests/entities/test-question.entity';
import { Question } from '../questions/entities/question.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TestAttempt,
      TestQuestion,
      Question,
    ]),
  ],
  controllers: [AttemptsController],
  providers: [AttemptsService],
  exports: [AttemptsService],
})
export class AttemptsModule {} 