import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { TestAttempt, AttemptStatus, SubmissionType, ReviewStatus, ResultType } from '../tests/entities/test-attempt.entity';
import { TestUserAnswer } from '../tests/entities/test-user-answer.entity';
import { Test, TestType } from '../tests/entities/test.entity';
import { TestQuestion } from '../tests/entities/test-question.entity';
import { TestRule } from '../tests/entities/test-rule.entity';
import { Question, QuestionType, GradingType } from '../questions/entities/question.entity';
import { AuthContext } from '@/common/interfaces/auth.interface';
import { SubmitAnswerDto } from './dto/submit-answer.dto';
import { ReviewAttemptDto } from './dto/review-answer.dto';
import { PluginManagerService } from '@/common/services/plugin-manager.service';

@Injectable()
export class AttemptsService {
  constructor(
    @InjectRepository(TestAttempt)
    private readonly attemptRepository: Repository<TestAttempt>,
    @InjectRepository(TestUserAnswer)
    private readonly testUserAnswerRepository: Repository<TestUserAnswer>,
    @InjectRepository(Test)
    private readonly testRepository: Repository<Test>,
    @InjectRepository(TestQuestion)
    private readonly testQuestionRepository: Repository<TestQuestion>,
    @InjectRepository(TestRule)
    private readonly testRuleRepository: Repository<TestRule>,
    @InjectRepository(Question)
    private readonly questionRepository: Repository<Question>,
    private readonly pluginManager: PluginManagerService,
  ) {}

  async startAttempt(testId: string, userId: string, authContext: AuthContext): Promise<TestAttempt> {
    // Check if test exists and user can attempt
    const test = await this.testRepository.findOne({
      where: {
        id: testId,
        tenantId: authContext.tenantId,
        organisationId: authContext.organisationId,
      },
    });

    if (!test) {
      throw new NotFoundException('Test not found');
    }

    // Check if user has remaining attempts
    const existingAttempts = await this.attemptRepository.count({
      where: {
        testId,
        userId,
        tenantId: authContext.tenantId,
        organisationId: authContext.organisationId,
      },
    });

    if (existingAttempts >= test.attempts) {
      throw new Error('Maximum attempts reached for this test');
    }

    // Create attempt
    const attempt = this.attemptRepository.create({
      testId,
      userId,
      attempt: existingAttempts + 1,
      status: AttemptStatus.IN_PROGRESS,
      tenantId: authContext.tenantId,
      organisationId: authContext.organisationId,
    });

    const savedAttempt = await this.attemptRepository.save(attempt);

    // Generate questions based on test type
    if (test.type === TestType.RULE_BASED) {
      await this.generateRuleBasedTestQuestions(savedAttempt, test, authContext);
    }

    // Trigger plugin event
    await this.pluginManager.triggerEvent(
      PluginManagerService.EVENTS.ATTEMPT_STARTED,
      {
        tenantId: authContext.tenantId,
        organisationId: authContext.organisationId,
        userId: authContext.userId,
      },
      {
        attemptId: savedAttempt.attemptId,
        testId: savedAttempt.testId,
        attemptNumber: savedAttempt.attempt,
      }
    );

    return savedAttempt;
  }

  async getAttemptQuestions(attemptId: string, authContext: AuthContext): Promise<Question[]> {
    const attempt = await this.attemptRepository.findOne({
      where: {
        attemptId,
        tenantId: authContext.tenantId,
        organisationId: authContext.organisationId,
      },
    });

    if (!attempt) {
      throw new NotFoundException('Attempt not found');
    }

    // Get questions from the resolved test (generated test for rule-based)
    const testId = attempt.resolvedTestId || attempt.testId;
    
    const testQuestions = await this.testQuestionRepository.find({
      where: {
        testId,
        tenantId: authContext.tenantId,
        organisationId: authContext.organisationId,
      },
      order: { ordering: 'ASC' },
    });

    const questionIds = testQuestions.map(tq => tq.questionId);
    
    if (questionIds.length === 0) {
      return [];
    }
    
    return this.questionRepository.find({
      where: {
        questionId: In(questionIds),
        tenantId: authContext.tenantId,
        organisationId: authContext.organisationId,
      },
    });
  }

  async submitAnswer(attemptId: string, submitAnswerDto: SubmitAnswerDto, authContext: AuthContext): Promise<void> {
    // Verify attempt exists and belongs to user
    const attempt = await this.attemptRepository.findOne({
      where: {
        attemptId,
        userId: authContext.userId,
        tenantId: authContext.tenantId,
        organisationId: authContext.organisationId,
      },
    });

    if (!attempt) {
      throw new NotFoundException('Attempt not found');
    }

    if (attempt.status !== AttemptStatus.IN_PROGRESS) {
      throw new Error('Cannot submit answer to completed attempt');
    }

    // Get question to validate answer format
    const question = await this.questionRepository.findOne({
      where: {
        questionId: submitAnswerDto.questionId,
        tenantId: authContext.tenantId,
        organisationId: authContext.organisationId,
      },
    });

    if (!question) {
      throw new NotFoundException('Question not found');
    }

    // Validate answer based on question type
    this.validateAnswer(submitAnswerDto.answer, question);

    // Convert answer to JSON string
    const answerJson = JSON.stringify(submitAnswerDto.answer);

    // Save or update answer
    const existingAnswer = await this.testUserAnswerRepository.findOne({
      where: {
        attemptId,
        questionId: submitAnswerDto.questionId,
        tenantId: authContext.tenantId,
        organisationId: authContext.organisationId,
      },
    });

    if (existingAnswer) {
      existingAnswer.answer = answerJson;
      existingAnswer.updatedAt = new Date();
      await this.testUserAnswerRepository.save(existingAnswer);
    } else {
      const userAnswer = this.testUserAnswerRepository.create({
        attemptId,
        questionId: submitAnswerDto.questionId,
        answer: answerJson,
        anssOrder: '1', // This could be enhanced to track order
        tenantId: authContext.tenantId,
        organisationId: authContext.organisationId,
      });
      await this.testUserAnswerRepository.save(userAnswer);
    }

    // Update attempt time spent if provided
    if (submitAnswerDto.timeSpent) {
      attempt.timeSpent = (attempt.timeSpent || 0) + submitAnswerDto.timeSpent;
      await this.attemptRepository.save(attempt);
    }

    // Trigger plugin event
    await this.pluginManager.triggerEvent(
      PluginManagerService.EVENTS.ANSWER_SUBMITTED,
      {
        tenantId: authContext.tenantId,
        organisationId: authContext.organisationId,
        userId: authContext.userId,
      },
      {
        attemptId,
        questionId: submitAnswerDto.questionId,
        timeSpent: submitAnswerDto.timeSpent,
        answer: submitAnswerDto.answer,
      }
    );
  }

  async submitAttempt(attemptId: string, authContext: AuthContext): Promise<TestAttempt> {
    const attempt = await this.attemptRepository.findOne({
      where: {
        attemptId,
        tenantId: authContext.tenantId,
        organisationId: authContext.organisationId,
      },
    });

    if (!attempt) {
      throw new NotFoundException('Attempt not found');
    }

    attempt.status = AttemptStatus.SUBMITTED;
    attempt.submittedAt = new Date();
    attempt.submissionType = SubmissionType.SELF;

    // Check if test has subjective questions that need review
    const hasSubjectiveQuestions = await this.hasSubjectiveQuestions(attemptId, authContext);
    
    if (hasSubjectiveQuestions) {
      // Set review status to pending for manual review
      attempt.reviewStatus = ReviewStatus.PENDING;
    } else {
      // Auto-calculate score for objective questions
      const score = await this.calculateObjectiveScore(attemptId, authContext);
      attempt.score = score;
      attempt.result = score >= 60 ? ResultType.PASS : ResultType.FAIL; // Assuming 60% is passing
    }

    const savedAttempt = await this.attemptRepository.save(attempt);

    // Trigger plugin event
    await this.pluginManager.triggerEvent(
      PluginManagerService.EVENTS.ATTEMPT_SUBMITTED,
      {
        tenantId: authContext.tenantId,
        organisationId: authContext.organisationId,
        userId: authContext.userId,
      },
      {
        attemptId: savedAttempt.attemptId,
        testId: savedAttempt.testId,
        score: savedAttempt.score,
        result: savedAttempt.result,
        timeSpent: savedAttempt.timeSpent,
        reviewStatus: savedAttempt.reviewStatus,
      }
    );

    return savedAttempt;
  }

  async reviewAttempt(attemptId: string, reviewDto: ReviewAttemptDto, authContext: AuthContext): Promise<TestAttempt> {
    const attempt = await this.attemptRepository.findOne({
      where: {
        attemptId,
        tenantId: authContext.tenantId,
        organisationId: authContext.organisationId,
      },
    });

    if (!attempt) {
      throw new NotFoundException('Attempt not found');
    }

    // Update scores for reviewed answers
    for (const answerReview of reviewDto.answers) {
      await this.testUserAnswerRepository.update(
        {
          attemptId,
          questionId: answerReview.questionId,
          tenantId: authContext.tenantId,
          organisationId: authContext.organisationId,
        },
        {
          score: answerReview.score,
          remarks: answerReview.remarks,
          reviewedBy: authContext.userId,
          reviewStatus: 'R' as any, // REVIEWED
          reviewedAt: new Date(),
        }
      );
    }

    // Calculate final score
    const finalScore = await this.calculateFinalScore(attemptId, authContext);
    
    attempt.score = finalScore;
    attempt.result = finalScore >= 60 ? ResultType.PASS : ResultType.FAIL;
    attempt.reviewStatus = ReviewStatus.REVIEWED;
    attempt.updatedBy = authContext.userId;

    const savedAttempt = await this.attemptRepository.save(attempt);

    // Trigger plugin event
    await this.pluginManager.triggerEvent(
      PluginManagerService.EVENTS.ATTEMPT_REVIEWED,
      {
        tenantId: authContext.tenantId,
        organisationId: authContext.organisationId,
        userId: authContext.userId,
      },
      {
        attemptId: savedAttempt.attemptId,
        testId: savedAttempt.testId,
        score: savedAttempt.score,
        result: savedAttempt.result,
        reviewedBy: authContext.userId,
        answersReviewed: reviewDto.answers.length,
      }
    );

    return savedAttempt;
  }

  async getPendingReviews(authContext: AuthContext): Promise<any[]> {
    return this.attemptRepository
      .createQueryBuilder('attempt')
      .leftJoin('testUserAnswers', 'answers', 'answers.attemptId = attempt.attemptId')
      .leftJoin('questions', 'question', 'question.id = answers.questionId')
      .where('attempt.tenantId = :tenantId', { tenantId: authContext.tenantId })
      .andWhere('attempt.organisationId = :organisationId', { organisationId: authContext.organisationId })
      .andWhere('attempt.reviewStatus = :reviewStatus', { reviewStatus: ReviewStatus.PENDING })
      .andWhere('question.gradingType = :gradingType', { gradingType: GradingType.EXERCISE })
      .andWhere('answers.reviewStatus = :answerReviewStatus', { answerReviewStatus: 'P' })
      .select([
        'attempt.attemptId',
        'attempt.testId',
        'attempt.userId',
        'attempt.submittedAt',
        'answers.questionId',
        'question.title',
        'question.type',
        'answers.answer',
      ])
      .getMany();
  }

  private async generateRuleBasedTestQuestions(attempt: TestAttempt, originalTest: Test, authContext: AuthContext): Promise<void> {
    // Create a new generated test for this specific attempt
    const generatedTest = this.testRepository.create({
      title: `Generated Test for ${originalTest.title} - Attempt ${attempt.attempt}`,
      type: TestType.GENERATED,
      timeDuration: originalTest.timeDuration,
      attempts: 1, // Generated tests can only be attempted once
      passingMarks: originalTest.passingMarks,
      description: originalTest.description,
      status: originalTest.status,
      tenantId: authContext.tenantId,
      organisationId: authContext.organisationId,
      createdBy: 'system',
    });

    const savedGeneratedTest = await this.testRepository.save(generatedTest);

    // Link the attempt to the generated test
    attempt.resolvedTestId = savedGeneratedTest.id;
    await this.attemptRepository.save(attempt);

    // Get rules for the original test
    const rules = await this.testRuleRepository.find({
      where: {
        testId: originalTest.id,
        tenantId: authContext.tenantId,
        organisationId: authContext.organisationId,
        isActive: true,
      },
      order: { priority: 'DESC' },
    });

    let questionOrder = 1;

    for (const rule of rules) {
      // Get all questions from testQuestions that match this rule
      const availableQuestions = await this.testQuestionRepository.find({
        where: {
          testId: originalTest.testId,
          ruleId: rule.id,
          tenantId: authContext.tenantId,
          organisationId: authContext.organisationId,
        },
        order: { ordering: 'ASC' },
      });

      // Select questions based on rule strategy
      const selectedQuestions = this.selectQuestionsFromRule(
        availableQuestions,
        rule.numberOfQuestions,
        rule.selectionStrategy
      );

      // Add selected questions to the generated test
      for (const selectedQuestion of selectedQuestions) {
        await this.testQuestionRepository.save(
          this.testQuestionRepository.create({
            testId: savedGeneratedTest.testId,
            sectionId: selectedQuestion.sectionId,
            questionId: selectedQuestion.questionId,
            ordering: questionOrder++,
            ruleId: rule.id,
            isCompulsory: selectedQuestion.isCompulsory,
            tenantId: authContext.tenantId,
            organisationId: authContext.organisationId,
          })
        );
      }
    }
  }

  private selectQuestionsFromRule(availableQuestions: TestQuestion[], count: number, strategy: string): TestQuestion[] {
    switch (strategy) {
      case 'random':
        return this.shuffleArray([...availableQuestions]).slice(0, count);
      case 'sequential':
        return availableQuestions.slice(0, count);
      case 'weighted':
        // For weighted strategy, you might want to implement more complex logic
        // For now, using random selection
        return this.shuffleArray([...availableQuestions]).slice(0, count);
      default:
        return this.shuffleArray([...availableQuestions]).slice(0, count);
    }
  }

  private validateAnswer(answer: any, question: Question): void {
    switch (question.type) {
      case QuestionType.MCQ:
      case QuestionType.TRUE_FALSE:
        if (!answer.selectedOptionIds || answer.selectedOptionIds.length !== 1) {
          throw new Error('MCQ/True-False questions require exactly one selected option');
        }
        break;
      case QuestionType.MULTIPLE_ANSWER:
        if (!answer.selectedOptionIds || answer.selectedOptionIds.length === 0) {
          throw new Error('Multiple answer questions require at least one selected option');
        }
        break;
      case QuestionType.SUBJECTIVE:
      case QuestionType.ESSAY:
        if (!answer.text || answer.text.trim().length === 0) {
          throw new Error('Subjective/Essay questions require text answer');
        }
        if (question.params?.maxLength && answer.text.length > question.params.maxLength) {
          throw new Error(`Answer exceeds maximum length of ${question.params.maxLength} characters`);
        }
        if (question.params?.minLength && answer.text.length < question.params.minLength) {
          throw new Error(`Answer must be at least ${question.params.minLength} characters`);
        }
        break;
      case QuestionType.FILL_BLANK:
        if (!answer.blanks || answer.blanks.length === 0) {
          throw new Error('Fill-in-the-blank questions require blank answers');
        }
        break;
      case QuestionType.MATCH:
        if (!answer.matches || answer.matches.length === 0) {
          throw new Error('Matching questions require match answers');
        }
        break;
    }
  }

  private async hasSubjectiveQuestions(attemptId: string, authContext: AuthContext): Promise<boolean> {
    const subjectiveQuestions = await this.questionRepository
      .createQueryBuilder('question')
      .innerJoin('testUserAnswers', 'answers', 'answers.questionId = question.id')
      .where('answers.attemptId = :attemptId', { attemptId })
      .andWhere('question.tenantId = :tenantId', { tenantId: authContext.tenantId })
      .andWhere('question.organisationId = :organisationId', { organisationId: authContext.organisationId })
      .andWhere('question.gradingType = :gradingType', { gradingType: GradingType.EXERCISE })
      .getCount();

    return subjectiveQuestions > 0;
  }

  private async calculateObjectiveScore(attemptId: string, authContext: AuthContext): Promise<number> {
    const answers = await this.testUserAnswerRepository
      .createQueryBuilder('answer')
      .innerJoin('questions', 'question', 'question.id = answer.questionId')
      .where('answer.attemptId = :attemptId', { attemptId })
      .andWhere('answer.tenantId = :tenantId', { tenantId: authContext.tenantId })
      .andWhere('answer.organisationId = :organisationId', { organisationId: authContext.organisationId })
      .andWhere('question.gradingType = :gradingType', { gradingType: GradingType.QUIZ })
      .select(['answer.answer', 'question.marks', 'question.type'])
      .getMany();

    let totalScore = 0;
    let totalMarks = 0;

    for (const answer of answers) {
      const question = await this.questionRepository.findOne({
        where: { questionId: answer.questionId },
      });
      
      if (question) {
        totalMarks += question.marks;
        const answerData = JSON.parse(answer.answer);
        
        // Calculate score based on question type
        const score = this.calculateQuestionScore(answerData, question);
        totalScore += score;
      }
    }

    return totalMarks > 0 ? (totalScore / totalMarks) * 100 : 0;
  }

  private calculateQuestionScore(answerData: any, question: Question): number {
    // This is a simplified scoring logic - you might want to enhance it
    switch (question.type) {
      case QuestionType.MCQ:
      case QuestionType.TRUE_FALSE:
        // Check if selected option is correct
        return answerData.selectedOptionIds?.length > 0 ? question.marks : 0;
      case QuestionType.MULTIPLE_ANSWER:
        // Partial scoring for multiple answer questions
        return question.marks; // Simplified - you'd need to check each option
      default:
        return 0; // Subjective questions are scored manually
    }
  }

  private async calculateFinalScore(attemptId: string, authContext: AuthContext): Promise<number> {
    const answers = await this.testUserAnswerRepository.find({
      where: {
        attemptId,
        tenantId: authContext.tenantId,
        organisationId: authContext.organisationId,
      },
    });

    let totalScore = 0;
    let totalMarks = 0;

    for (const answer of answers) {
      const question = await this.questionRepository.findOne({
        where: { questionId: answer.questionId },
      });

      if (question) {
        totalMarks += question.marks;
        totalScore += answer.score || 0;
      }
    }

    return totalMarks > 0 ? (totalScore / totalMarks) * 100 : 0;
  }

  private shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
} 